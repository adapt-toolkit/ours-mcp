// ours messenger packet.
//
// One ADAPT node == one of these packets. Two nodes talk directly, peer to
// peer, through a relay broker (no central server). Messages are end-to-end
// encrypted; the key exchange is handled for us by the stdlib `encrypted_channel`
// library — we only ever address peers by their container id.
//
// The shared transaction logic lives in the ours-mufl-core repo (checked
// out as the core/ subfolder of this directory): `a2a_protocol` (wire shapes +
// verification), `a2a_messaging` (contact + message wire path, addressed
// ::a2a_messaging::<name> by the host), and `version`. They are shared with
// the web messenger — change them there, bump core_version, and recompile
// every consumer.
//
// This packet keeps only what is agent-specific:
//   - the inbox message store with its lifecycle (unread -> processed ->
//     ready_to_delete -> deleted; see get_messages / gc / defer_messages)
//   - the local contact book + identity hierarchy transactions (host-fired)
//   - export_state / import_state wrappers composing the core helpers with
//     the app-side fields (including the legacy-blob migrations)
//   - ::actor:: compat shims for the network-visible inbound transactions
//     (accept_contact, receive_message) — pre-migration peers send to these
//     names, and the core keeps SENDING to them too (Option A: zero network
//     break; drop both only when no old clients remain)
//
// Storage is wired into the core via a2a_messaging::init hooks (see the
// hidden block): on_message_received deposits into the inbox (or the
// pending-introduction queue for unknown senders); send/remove hooks are
// agent no-ops.
//
// User transactions (each backs one MCP tool, except gc which the host fires):
//   ::a2a_messaging::set_my_name        — set the display name peers see for me
//   ::a2a_messaging::set_my_bio         — set my profile bio (free-text, self-asserted)
//   ::a2a_messaging::generate_invite    — make an invite blob for a named peer
//   ::a2a_messaging::add_contact        — join via an invite blob, reply to the inviter
//   ::a2a_messaging::send_message       — send an e2e-encrypted message to a contact
//   ::a2a_messaging::remove_contact     — forget a contact
//   ::a2a_messaging::list_contacts      — (readonly) my contacts
//   ::a2a_messaging::list_contact_roots — (readonly) verified root linkage per contact
//   ::a2a_messaging::get_version        — (readonly) shared-core version
//   list_incoming_messages  — (readonly) my inbox, with per-message id + status
//   get_messages            — return unread messages + mark them processed (sole body egress)
//   defer_messages          — flip processed/ready_to_delete messages back to unread
//   gc                      — two-generation GC of handled messages (host-fired, not a tool)
//   ::a2a_messaging::flush_deferred — (host-fired) replay deferred queues once conditions clear
//   restore_degraded_contacts — (host-fired) (re)issue restore requests for every degraded contact
//   list_degraded_contacts  — (readonly) contacts currently degraded (channel needs restore)
//   list_deferred_queues    — (readonly) per-contact deferred-message queue sizes
//
// Identity hierarchy (host-fired transactions):
//   sign_delegation         — root-only in practice: sign a delegation cert for a role
//   export_root_profile     — root-only in practice: my self-signed root profile blob
//   set_delegation          — role: store my verified delegation cert + root material
//   describe_identity       — (readonly) name/bio/hierarchy position
//   connect_sibling         — register an intra-root peer + send sibling_introduce
//
// Local contact book (host-fired transactions; see the design notes above
// local_introduce below):
//   export_address_document — (readonly) my signed address document as a blob
//   pin_registrar           — pin the host registrar's signing keys (pin-once)
//   set_local_policy        — toggle auto-accept of local introductions
//   mint_introduction       — registrar-only in practice: sign an introduction credential
//   sign_book_entry         — registrar-only in practice: sign a contact-book entry
//   connect_local           — register a book contact + send local_introduce (+ first message)
//   approve_introduction    — accept a pending local introduction (flushes its queue)
//   reject_introduction     — drop a pending local introduction
//   list_pending_introductions — (readonly) pending introductions (names + queue sizes)
//
// Monitoring + control plane (host-fired unless noted):
//   get_monitoring_status   — (readonly) enabled flag / proxy binding / queue sizes
//   sign_monitoring_auth    — root-only: sign an enable/disable auth for a role
//   set_monitoring          — role: verify the root-signed auth, set the flag
//   get_monitoring_copies   — root: drain queued copies for proxy forwarding
//   get_control_requests    — root: drain queued proxy control requests
//   set_proxy_pending       — root: store the host-generated 6-digit code
//   verify_proxy_code       — root: check a bind attempt (atomic attempts/expiry)
//   clear_monitoring_proxy  — root: drop the proxy binding
//   ::a2a_control::send_control — send an opaque control payload to a contact
//
// External transactions (inbound, not exposed as tools):
//   accept_contact          — inviter learns the joiner's identity + name (core shim)
//   receive_message         — store a decrypted inbound message (core shim)
//   receive_monitoring_copy — a monitored role of mine reports a message copy
//   ::a2a_control::control_message — control payload from a contact (queued for the daemon)
//   local_introduce         — same-host peer connects via the local contact book
//   sibling_introduce       — intra-root peer connects, authorized by its delegation cert
//   ::a2a_messaging::request_contact_restore / submit_restore_response / complete_restore
//                            — contact-restore handshake (signed re-key between known contacts)

application actor loads libraries
    identity_proof_document,
    attestation_document,
    native_attestation_document,
    transaction_message_decoder,
    address_document,
    address_document_types,
    key_utils,
    key_storage,
    continuation,
    encrypted_channel,
    current_transaction_info,
    a2a_protocol,
    a2a_messaging,
    a2a_capabilities,
    a2a_cluster,
    a2a_control,
    protocol_container,
    registration_proof,
    version
    uses transactions
{
    hidden
    {
        // A received message carries a stable per-packet id and a lifecycle status:
        // "unread" (just arrived) -> "processed" (handed to the agent via
        // get_messages) -> "ready_to_delete" (first gc tick) -> deleted (next gc
        // tick). defer_messages flips "processed"/"ready_to_delete" back to "unread"
        // so another session can pick it up — restorable from either generation,
        // which is what makes the two-generation gc window race-free.
        // $wire_id is the sender-stamped, cross-side handle ("" when the sender
        // predates wire ids, or for introduction first-messages); $reply_to is
        // the optional pointer at the message this one replies to (NIL = not a
        // reply). Both are surfaced by get_messages so an agent can reference a
        // message in a reply and recognize an incoming reply pointer.
        metadef message_t: ($msg_id -> int, $sender_id -> global_id, $sender_name -> str, $text -> str, $date -> time, $status -> str, $wire_id -> str, $reply_to -> a2a_protocol::reply_ref_t+).
        // File store (parallels message_t). Unlike the reference test_actor.mu — a QA
        // probe that keeps metadata only — a real consumer must hand the bytes back, so
        // $data carries the bytes in packet state; they leave only via get_files.
        metadef file_t: ($file_id -> int, $sender_id -> global_id, $sender_name -> str, $filename -> str, $mime -> str, $data -> bin, $date -> time, $status -> str, $wire_id -> str, $reply_to -> a2a_protocol::reply_ref_t+).
        // The pre-lifecycle inbox shape (no per-message id/status). import_state
        // migrates blobs in this shape forward — see below.
        metadef legacy_message_t: ($sender_id -> global_id, $sender_name -> str, $text -> str, $date -> time).

        // A not-yet-approved local introduction, with its bounded message queue.
        // (The local-book WIRE shapes — intro_t, signed_intro_t, book_entry_t —
        // live in a2a_protocol; these three are packet-local state/view shapes.)
        metadef pending_msg_t: ($text -> str, $date -> time).
        metadef pending_intro_t: ($name -> str, $ad -> address_document_types::t_address_document, $messages -> pending_msg_t[]).
        metadef pending_view_t: ($name -> str, $queued -> int).

        // Acceptance window for an introduction credential (seconds since mint;
        // small negative slack for clock oddities) and the matching nonce-table
        // retention horizon (window + slack, so a nonce outlives its credential).
        intro_max_age_seconds is int = 300.
        intro_max_skew_seconds is int = 30.
        seen_nonce_cap is int = 1024.
        pending_queue_cap is int = 50.

        // ---- monitoring shapes + limits ----
        // Root-signed authorization for flipping a role's monitoring flag. Like
        // a delegation cert, verified against the role's pinned root keys, so
        // only this hierarchy's root can change what its roles report.
        metadef monitoring_auth_core_t: ($version -> int, $role_cid -> global_id, $enabled -> bool, $issued_at -> time).
        metadef monitoring_auth_t: ($c -> monitoring_auth_core_t, $s -> crypto_signature).
        // One monitored message, as the role reports it to its root.
        metadef monitoring_copy_t: (
            $version     -> int,
            $source_cid  -> global_id,
            $source_name -> str,
            $direction   -> str,
            $peer_cid    -> global_id,
            $peer_name   -> str,
            $date        -> time,
            $body        -> str
        ).
        // Proxy binding (root only): a pending 6-digit-code verification and
        // the verified binding that replaces it on success.
        metadef proxy_pending_t: ($code -> str, $proxy_cid -> global_id, $created_at -> time, $attempts -> int).
        metadef proxy_binding_t: ($proxy_cid -> global_id, $bound_at -> time).
        // One queued control request from the bound browser proxy.
        metadef control_req_t: ($sender_cid -> global_id, $sender_name -> str, $payload -> str, $date -> time).

        proxy_code_max_age_seconds is int = 300.
        proxy_max_attempts is int = 3.
        monitoring_inbox_cap is int = 500.
        control_inbox_cap is int = 200.

        // Wire the deserialization primitive into the libraries that need it.
        _read_or_abort = grab( _read_or_abort ).
        key_storage::init ($_read_or_abort -> _read_or_abort).
        encrypted_channel::init ($_read_or_abort -> _read_or_abort).

        // ---- packet state ---------------------------------------------------
        // (The shared contact/profile/hierarchy state — my_name, contacts,
        // pending_invites, peer_ads, my_bio, delegation_cert, root_ad,
        // root_profile, contact_roots — lives in a2a_messaging and is read /
        // assigned as a2a_messaging::<field> below.)
        //
        // Received messages. Each carries its own lifecycle status (see
        // message_t / get_messages / gc / defer_messages), so the
        // packet is the single authority on what has been read or processed —
        // no host-side cursor, safe across concurrent sessions.
        inbox is message_t[] = [].
        // Monotonic source of per-message ids (the stable handle the agent uses
        // to mark a message processed or defer it).
        next_msg_seq is int = 1.
        files is file_t[] = [].
        next_file_seq is int = 1.
        // The host registrar's address document (pinned once at identity
        // creation / injected on upgrade) — its $identity $key_list is what
        // introduction credentials are verified against. NIL means this identity
        // accepts no local-book introductions at all.
        registrar_ad is address_document_types::t_address_document+ = NIL.
        // Whether a verified local introduction registers the joiner immediately
        // (TRUE) or parks it in pending_introductions for explicit approval.
        local_auto_accept is bool = TRUE.
        // Replay guard for introduction credentials: nonce -> when it was seen.
        // Lazily purged past the freshness horizon, hard-capped at seen_nonce_cap.
        seen_nonces is (global_id ->> time) = (,).
        // Verified-but-unapproved local introductions (when auto-accept is off),
        // each with a bounded queue of messages awaiting approval.
        pending_introductions is (global_id ->> pending_intro_t) = (,).

        // ---- monitoring state -------------------------------------------------
        // Whether THIS packet (a role) reports its message traffic to its root.
        // Only flipped by a root-signed authorization (set_monitoring).
        monitoring_enabled is bool = FALSE.
        // Root only: copies received from monitored roles, awaiting the host's
        // get_monitoring_copies pull (forwarded to the bound proxy). Capped;
        // oldest copies are dropped first when no proxy drains the queue.
        monitoring_inbox is monitoring_copy_t[] = [].
        // Root only: the in-flight proxy binding (6-digit code verification)
        // and the verified proxy that monitoring traffic is forwarded to.
        proxy_pending is proxy_pending_t+ = NIL.
        monitoring_proxy is proxy_binding_t+ = NIL.
        // Root only: control requests from the bound proxy, awaiting the
        // host's get_control_requests pull. Kept out of the message inbox so
        // agent sessions never see them.
        control_inbox is control_req_t[] = [].

        // Signal the host to persist the packet. Only emitted at the end of a
        // complete procedure — intermediate states (e.g. channel handshake) are
        // never saved, so a crash mid-handshake restores to the last stable point.
        fn _save_state (_) = (transaction::action::return_data ($kind -> $save_state)).
        fn _return_data (payload: any) = (transaction::action::return_data ($kind -> $data, $payload -> payload)).
        fn _notify_agent (payload: any) = (transaction::action::return_data ($kind -> $notify_agent, $payload -> payload)).

        // A typed NIL reply pointer, passed by the call sites that deposit a
        // message with no reply context (introduction first-messages, approval
        // flush). A bare NIL literal cannot infer the nullable reply_ref_t type
        // at the call; this binding gives it one.
        no_reply is a2a_protocol::reply_ref_t+ = NIL.

        // Append a message to the inbox under a fresh id; returns the id.
        // wire_id is "" for introduction first-messages and pre-1.4 senders;
        // reply_to is NIL unless the sender marked this a reply.
        fn deposit_message (sender_id: global_id, sender_name: str, text: str, msg_date: time, wire_id: str, reply_to: a2a_protocol::reply_ref_t+) -> int
        {
            mid = next_msg_seq.
            next_msg_seq -> next_msg_seq + 1.
            inbox (_count inbox|) -> (
                $msg_id      -> mid,
                $sender_id   -> sender_id,
                $sender_name -> sender_name,
                $text        -> text,
                $date        -> msg_date,
                $status      -> "unread",
                $wire_id     -> wire_id,
                $reply_to    -> reply_to
            ).
            return mid.
        }

        // Append a received file under a fresh id; returns the id. Mirrors
        // deposit_message; status starts "unread" and the bytes ($data) ride along.
        fn deposit_file (sender_id: global_id, sender_name: str, filename: str, mime: str, data: bin, file_date: time, wire_id: str, reply_to: a2a_protocol::reply_ref_t+) -> int
        {
            fid = next_file_seq.
            next_file_seq -> next_file_seq + 1.
            files (_count files|) -> (
                $file_id     -> fid,
                $sender_id   -> sender_id,
                $sender_name -> sender_name,
                $filename    -> filename,
                $mime        -> mime,
                $data        -> data,
                $date        -> file_date,
                $status      -> "unread",
                $wire_id     -> wire_id,
                $reply_to    -> reply_to
            ).
            return fid.
        }

        // Build the monitoring-copy action for one message IF this packet is a
        // monitored role with a live encrypted channel to its root; [] otherwise.
        // The is_container_registered guard makes a missing/lost root channel
        // degrade to "no copy" instead of failing the user's message — the
        // enable flow (host-side) establishes the channel via connect_sibling.
        fn monitor_copy_actions (direction: str, peer_cid: global_id, text: str, msg_date: time) -> transaction::action::type[]
        {
            if monitoring_enabled == FALSE || a2a_messaging::delegation_cert == NIL { return []. }
            root_cid = a2a_messaging::delegation_cert? $c $root_cid.
            if key_storage::is_container_registered(root_cid) != TRUE { return []. }

            peer_name is str = "".
            p = a2a_messaging::contacts peer_cid.
            if p != NIL { peer_name -> p? $name. }

            copy is monitoring_copy_t = (
                $version     -> 1,
                $source_cid  -> _get_container_id(),
                $source_name -> a2a_messaging::my_name,
                $direction   -> direction,
                $peer_cid    -> peer_cid,
                $peer_name   -> peer_name,
                $date        -> msg_date,
                $body        -> text
            ).
            return [
                encrypted_channel::send_encrypted_tx root_cid (
                    $name -> "::actor::receive_monitoring_copy",
                    $targ -> ($copy -> copy)
                )
            ].
        }

        // Resolve a pending introduction by joiner name or stringified container
        // id; aborts when nothing matches.
        fn resolve_pending (ref: str) -> global_id
        {
            found is global_id+ = NIL.
            sc pending_introductions -- (cid -> p) ?? found == NIL && ((p $name) == ref || (_str cid) == ref)
            {
                found -> cid.
            }
            abort "No pending introduction matches: " + ref when found == NIL.
            return found?.
        }

        // Wire the agent's storage into the shared messaging core. The receive
        // hook owns everything app-specific about an inbound message: known
        // senders deposit into the inbox; an unknown sender may be a verified-
        // but-unapproved local introduction messaging before approval — queue
        // (bounded) inside its pending entry, approval flushes the queue into
        // the inbox in order; anything else from an unknown sender is rejected.
        // The notification deliberately carries NO message body — only that a
        // message arrived, from whom, and its id. The body stays in the packet
        // and only leaves through get_messages.
        a2a_messaging::init (
            $_read_or_abort -> _read_or_abort,
            $on_message_received -> fn (arg: any) -> transaction::action::type[]
            {
                sender_id = (arg $sender_id) safe global_id.
                text = (arg $text) safe str.
                msg_date = (arg $date) safe time.
                wire_id is str = "".
                if (arg $wire_id) != NIL { wire_id -> (arg $wire_id) safe str. }
                reply_to is a2a_protocol::reply_ref_t+ = NIL.
                if (arg $reply_to) != NIL { reply_to -> (arg $reply_to) safe a2a_protocol::reply_ref_t. }

                if (arg $sender_name) == NIL
                {
                    p = pending_introductions sender_id.
                    abort "Message from an unknown sender was rejected." when p == NIL.
                    entry = p?.
                    queued = entry $messages.
                    abort "Pending-introduction message queue is full; awaiting approval." when (_count queued|) >= pending_queue_cap.
                    queued (_count queued|) -> ($text -> text, $date -> msg_date).
                    pending_introductions sender_id -> ($name -> entry $name, $ad -> entry $ad, $messages -> queued).
                    return [
                        _notify_agent ($event -> $pending_message, $sender_name -> entry $name, $queued -> _count queued|),
                        _save_state NIL
                    ].
                }

                sender_name = (arg $sender_name) safe str.
                mid = deposit_message sender_id sender_name text msg_date wire_id reply_to.
                actions is transaction::action::type[] = [].
                sc monitor_copy_actions "in" sender_id text msg_date -- ( -> a)
                {
                    actions (_count actions|) -> a.
                }
                actions (_count actions|) -> _notify_agent ($event -> $message_received, $sender_name -> sender_name, $msg_id -> mid, $date -> msg_date).
                actions (_count actions|) -> _save_state NIL.
                return actions.
            },
            $on_message_sent -> fn (arg: any) -> transaction::action::type[]
            {
                return monitor_copy_actions "out" ((arg $target_id) safe global_id) ((arg $text) safe str) ((arg $date) safe time).
            },
            $on_contact_removed -> fn (_: any) -> transaction::action::type[] { return []. },
            // NEW (core 3.1): received a file. Reject unknown senders (no byte queuing —
            // D3), else deposit + a CONTENT-FREE notify (metadata only; bytes pulled later
            // by get_files). Arg names/order are fixed by the core contract.
            $on_file_received -> fn (arg: any) -> transaction::action::type[]
            {
                abort "File from an unknown sender was rejected." when (arg $sender_name) == NIL.
                sender_id = (arg $sender_id) safe global_id.
                sender_name = (arg $sender_name) safe str.
                fname = (arg $filename) safe str.
                mime is str = "".
                if (arg $mime) != NIL { mime -> (arg $mime) safe str. }
                file_date = (arg $date) safe time.
                data = (arg $data) safe bin.
                wire_id is str = "".
                if (arg $wire_id) != NIL { wire_id -> (arg $wire_id) safe str. }
                reply_to is a2a_protocol::reply_ref_t+ = NIL.
                if (arg $reply_to) != NIL { reply_to -> (arg $reply_to) safe a2a_protocol::reply_ref_t. }

                fid = deposit_file sender_id sender_name fname mime data file_date wire_id reply_to.
                return [
                    _notify_agent ($event -> $file_received, $sender_name -> sender_name, $file_id -> fid, $filename -> fname, $mime -> mime, $bytes -> _binlen data, $date -> file_date),
                    _save_state NIL
                ].
            },
            // NEW (core 3.1): a file was sent. This node is an agent, not a messenger —
            // it keeps no outbound-file history (parallels on_message_sent's lack of an
            // outbound store). Wired but a no-op.
            $on_file_sent -> fn (_: any) -> transaction::action::type[] { return []. }
        ).

        // Wire the control plane: control requests from the bound browser proxy queue in
        // control_inbox — NEVER the message inbox, so agent sessions don't see
        // them — and the notify event wakes the daemon's dispatcher. The
        // payload stays opaque here; sender authorization happens in the
        // daemon against the packet's monitoring_proxy / proxy_pending state.
        a2a_control::init (
            $on_control_received -> fn (arg: any) -> transaction::action::type[]
            {
                abort "Control queue is full." when (_count control_inbox|) >= control_inbox_cap.
                sender_name = (arg $sender_name) safe str.
                control_inbox (_count control_inbox|) -> (
                    $sender_cid  -> (arg $sender_id) safe global_id,
                    $sender_name -> sender_name,
                    $payload     -> (arg $payload) safe str,
                    $date        -> (arg $date) safe time
                ).
                return [
                    _notify_agent ($event -> $control_request, $sender_name -> sender_name, $queued -> _count control_inbox|),
                    _save_state NIL
                ].
            },
            // core 2.0 made $app_id a required init arg; it is auto-stamped on every
            // outgoing control message. MUST match the messenger's KNOWN_MCP id
            // (src/ui/viewmodel.ts) — the manifest below advertises the same id.
            $app_id -> "network.ours.mcp"
        ).

        // ---- capabilities manifest (core 2.0+) --------------------------------
        // Advertise this node's app identity + the capabilities it ACCEPTS. The
        // describe hook is the AUTHORITATIVE "do I accept introductions" gate:
        // a2a_messaging::ingest_connect_descriptor calls self_supports("core.connect")
        // against this live manifest on every relay, so an unwired describe FAILS
        // CLOSED (rejects all introductions — core 2.0 breaking change). app_id is the
        // messenger-recognized id. We advertise core.connect (accept introductions),
        // core.monitoring (governance-required, auto-present) and core.cluster (this
        // host's root + delegated-children control surface). We deliberately do NOT
        // advertise core.configuration — this node exposes no custom config panel.
        // core.cluster/monitoring/connect are now verb-DISPATCHED through
        // a2a_capabilities::dispatch into the shared-core a2a_cluster handlers
        // (control-protocol-to-MUFL), so they are wired into $supported + $handlers.
        // Built as explicitly-typed locals so the constant keys widen to the open
        // (str->>) / str[] types init expects (a bare literal infers a closed-key map).
        cap_supported is str[] = [
            a2a_capabilities::cap_cluster,
            a2a_capabilities::cap_monitoring,
            a2a_capabilities::cap_connect
        ].
        cap_handlers is (str ->> (any -> transaction::action::type[])) = (,).
        cap_handlers (a2a_capabilities::cap_cluster)    -> a2a_cluster::cluster_handler.
        cap_handlers (a2a_capabilities::cap_monitoring) -> a2a_cluster::monitoring_handler.
        cap_handlers (a2a_capabilities::cap_connect)    -> a2a_cluster::connect_handler.
        a2a_capabilities::init (
            $describe -> fn (_: any) -> a2a_capabilities::app_manifest_t {
                mon_status is str = "off".
                if monitoring_proxy != NIL { mon_status -> "on". }
                caps is (str ->> a2a_capabilities::capability_t) = (,).
                caps (a2a_capabilities::cap_connect) -> (
                    $cap -> a2a_capabilities::cap_connect, $version -> 1, $params -> "", $secrets -> (,)
                ).
                caps (a2a_capabilities::cap_monitoring) -> (
                    $cap -> a2a_capabilities::cap_monitoring, $version -> 1, $params -> "", $secrets -> (,)
                ).
                // core.cluster: this node hosts a root + delegated children and
                // exposes the cluster control verbs (list / create / update / remove
                // child, per-child monitoring, introduce) to a bound control plane.
                // core.cluster is verb-DISPATCHED via a2a_capabilities::dispatch into
                // a2a_cluster::cluster_handler (control-protocol-to-MUFL, core 2.11), so
                // it is wired in $supported + $handlers below. Keyed off the shared-core
                // constant a2a_capabilities::cap_cluster (= "core.cluster") so the
                // advertised id can never drift from the core registry.
                caps (a2a_capabilities::cap_cluster) -> (
                    $cap -> a2a_capabilities::cap_cluster, $version -> 1, $params -> "", $secrets -> (,)
                ).
                // DUAL-ADVERTISE (critic R6-6): also advertise the legacy app-scoped
                // "app.agents" id so a mixed-version control plane that still gates on
                // the old alias recognizes this node's cluster support and does not
                // mis-gate. Newer control planes key on core.cluster; both point at
                // the same control surface. Kept as an app.* literal by design — the
                // shared core never defines app.* ids.
                caps ("app.agents") -> (
                    $cap -> "app.agents", $version -> 1, $params -> "", $secrets -> (,)
                ).
                return (
                    $version           -> 2,
                    $app_id            -> "network.ours.mcp",
                    // The app manifest is a STATIC description of this MUFL app — NOT the
                    // runtime identity. $name names the app; the node's own display name
                    // (which root identity is running it) travels separately in the
                    // control reply's `root` field. Never source app metadata from my_name.
                    $name              -> "ours MCP host",
                    $description       -> "ours MCP daemon node",
                    $monitoring_status -> mon_status,
                    $capabilities      -> caps
                ).
            },
            // control-protocol-to-MUFL: verbs are DISPATCHED into the shared-core
            // handlers. $authorizer is the RR-9 non-bypassable gate (dispatch fail-fast
            // aborts if a controller verb routes without it). core.configuration is
            // deliberately omitted — this host exposes no config panel.
            // RR-9 non-bypassable authz gate: dispatch fail-fast aborts if a controller
            // verb routes without it. authorize_control takes `any` (core cf752ff), so it
            // wires directly — it reads the bound monitoring_proxy and returns whether
            // ($sender_id,$cap,$verb) is allowed.
            $authorizer -> a2a_messaging::authorize_control,
            $supported  -> cap_supported,
            $handlers   -> cap_handlers,
            $on_unknown -> fn (_: any) -> transaction::action::type[] { return []. }
        ).
    }

    // On recreation the host injects the persisted SIGN secret as init_arg: the
    // hex string of the Serialize()'d secretkey_sign. Deserialize it back
    // (_hex_string_to_binary -> _read_or_abort) and reseed to restore the
    // container address (adapt #77). Fresh-create passes no arg and the
    // bootstrapped identity stands.
    trn __init arg
    {
        // Fresh create passes no init_arg — the wrapper hands __init an empty
        // dict (not nil), so guard on the actual string type before deserializing
        // the persisted SIGN secret (Serialize()-hex) and reseeding (adapt #77).
        if _typeof arg == "STRING" {
            key_storage::reseed_identity_from_secret
                ((_read_or_abort (_hex_string_to_binary (arg SAFE(str)))) SAFE(secretkey_sign)).
        }
        return ::transaction::success[].
    }

    // ---- message store --------------------------------------------------------

    trn readonly list_incoming_messages _
    {
        return inbox.
    }

    // Hand the agent every message it has not seen yet (status "unread") and flip
    // those to "processed" — the ONLY place message bodies leave the packet, and
    // the sole dedup point: a message is returned exactly once, so an agent that
    // reads and acts immediately never double-processes. CRASH WINDOW: a
    // "processed" body has already left; an agent that crashes after get_messages
    // but before acting must defer_messages to recover it (-> "unread") before gc
    // promotes it through "ready_to_delete" and deletes it (>= 1 gc cycle).
    trn get_messages _
    {
        current_transaction_info::validate_origin_or_abort (transaction::envelope::origin::user,).

        fresh is message_t[] = [].
        new_inbox is message_t[] = [].
        sc inbox -- ( -> m)
        {
            if (m $status) == "unread"
            {
                processed_m is message_t = (
                    $msg_id      -> m $msg_id,
                    $sender_id   -> m $sender_id,
                    $sender_name -> m $sender_name,
                    $text        -> m $text,
                    $date        -> m $date,
                    $status      -> "processed",
                    $wire_id     -> m $wire_id,
                    $reply_to    -> m $reply_to
                ).
                fresh (_count fresh|) -> m.
                new_inbox (_count new_inbox|) -> processed_m.
            }
            else
            {
                new_inbox (_count new_inbox|) -> m.
            }
        }
        inbox -> new_inbox.

        return transaction::success [
            _return_data ($messages -> fresh),
            _save_state NIL
        ].
    }

    // ---- file store (parallels the message store) -----------------------------

    trn readonly list_incoming_files _
    {
        return files.
    }

    // Hand the agent every file it has not retrieved (status "unread"), returning
    // the BYTES, and flip those to "processed" — the ONLY place file bytes leave the
    // packet (mirrors get_messages). Same crash window: a "processed" file has left;
    // recover with defer_files before gc deletes it.
    trn get_files _
    {
        current_transaction_info::validate_origin_or_abort (transaction::envelope::origin::user,).

        fresh is file_t[] = [].
        new_files is file_t[] = [].
        sc files -- ( -> f)
        {
            if (f $status) == "unread"
            {
                processed_f is file_t = (
                    $file_id     -> f $file_id,
                    $sender_id   -> f $sender_id,
                    $sender_name -> f $sender_name,
                    $filename    -> f $filename,
                    $mime        -> f $mime,
                    $data        -> f $data,
                    $date        -> f $date,
                    $status      -> "processed",
                    $wire_id     -> f $wire_id,
                    $reply_to    -> f $reply_to
                ).
                fresh (_count fresh|) -> f.
                new_files (_count new_files|) -> processed_f.
            }
            else
            {
                new_files (_count new_files|) -> f.
            }
        }
        files -> new_files.

        return transaction::success [
            _return_data ($files -> fresh),
            _save_state NIL
        ].
    }

    // Put handled files back into the queue (status -> "unread"); mirrors
    // defer_messages. Restores from either post-read generation.
    trn defer_files _:($file_ids -> ids: int[])
    {
        current_transaction_info::validate_origin_or_abort (transaction::envelope::origin::user,).

        wanted is (int ->> bool) = (,).
        sc ids -- ( -> id) { wanted id -> TRUE. }

        new_files is file_t[] = [].
        deferred is int = 0.
        sc files -- ( -> f)
        {
            if (wanted (f $file_id)) && (((f $status) == "processed") || ((f $status) == "ready_to_delete"))
            {
                new_files (_count new_files|) -> (
                    $file_id     -> f $file_id,
                    $sender_id   -> f $sender_id,
                    $sender_name -> f $sender_name,
                    $filename    -> f $filename,
                    $mime        -> f $mime,
                    $data        -> f $data,
                    $date        -> f $date,
                    $status      -> "unread",
                    $wire_id     -> f $wire_id,
                    $reply_to    -> f $reply_to
                ).
                deferred -> deferred + 1.
            }
            else
            {
                new_files (_count new_files|) -> f.
            }
        }
        files -> new_files.

        return transaction::success [
            _return_data ($deferred -> deferred),
            _save_state NIL
        ].
    }

    // Two-generation garbage collection of handled messages, fired by the host on
    // a timer (NOT piggybacked on other transactions — that would collapse the
    // window under traffic). Order matters: (A) delete everything already marked
    // "ready_to_delete", THEN (B) promote "processed" -> "ready_to_delete". A
    // single pass keyed on the current status gives exactly that — a message is in
    // one status, so a freshly-processed message is promoted (not dropped) this
    // tick and only deleted on the NEXT tick, guaranteeing it survives a full
    // cycle (>= 1 interval) as a deferrable "ready_to_delete".
    trn gc _
    {
        current_transaction_info::validate_origin_or_abort (transaction::envelope::origin::user,).

        kept is message_t[] = [].
        deleted is int = 0.
        promoted is int = 0.
        sc inbox -- ( -> m)
        {
            if (m $status) == "ready_to_delete"
            {
                deleted -> deleted + 1.
            }
            elif (m $status) == "processed"
            {
                kept (_count kept|) -> (
                    $msg_id      -> m $msg_id,
                    $sender_id   -> m $sender_id,
                    $sender_name -> m $sender_name,
                    $text        -> m $text,
                    $date        -> m $date,
                    $status      -> "ready_to_delete",
                    $wire_id     -> m $wire_id,
                    $reply_to    -> m $reply_to
                ).
                promoted -> promoted + 1.
            }
            else
            {
                kept (_count kept|) -> m.
            }
        }
        inbox -> kept.

        // Same two-generation GC over the file store; file bytes are heavier than
        // message text, so reclaiming them matters more.
        kept_files is file_t[] = [].
        sc files -- ( -> f)
        {
            if (f $status) == "ready_to_delete"
            {
                deleted -> deleted + 1.
            }
            elif (f $status) == "processed"
            {
                kept_files (_count kept_files|) -> (
                    $file_id     -> f $file_id,
                    $sender_id   -> f $sender_id,
                    $sender_name -> f $sender_name,
                    $filename    -> f $filename,
                    $mime        -> f $mime,
                    $data        -> f $data,
                    $date        -> f $date,
                    $status      -> "ready_to_delete",
                    $wire_id     -> f $wire_id,
                    $reply_to    -> f $reply_to
                ).
                promoted -> promoted + 1.
            }
            else
            {
                kept_files (_count kept_files|) -> f.
            }
        }
        files -> kept_files.

        return transaction::success [
            _return_data ($deleted -> deleted, $promoted -> promoted),
            _save_state NIL
        ].
    }

    // Put handled messages back into the queue (status -> "unread") so a different
    // session picks them up on its next get_messages. Restores from EITHER post-
    // read generation — "processed" or "ready_to_delete" — so a message stays
    // recoverable across a full gc cycle. The opt-in counterpart to the safe
    // default: forgetting to defer just means the message stays handled by you.
    trn defer_messages _:($msg_ids -> ids: int[])
    {
        current_transaction_info::validate_origin_or_abort (transaction::envelope::origin::user,).

        wanted is (int ->> bool) = (,).
        sc ids -- ( -> id) { wanted id -> TRUE. }

        new_inbox is message_t[] = [].
        deferred is int = 0.
        sc inbox -- ( -> m)
        {
            if (wanted (m $msg_id)) && (((m $status) == "processed") || ((m $status) == "ready_to_delete"))
            {
                new_inbox (_count new_inbox|) -> (
                    $msg_id      -> m $msg_id,
                    $sender_id   -> m $sender_id,
                    $sender_name -> m $sender_name,
                    $text        -> m $text,
                    $date        -> m $date,
                    $status      -> "unread",
                    $wire_id     -> m $wire_id,
                    $reply_to    -> m $reply_to
                ).
                deferred -> deferred + 1.
            }
            else
            {
                new_inbox (_count new_inbox|) -> m.
            }
        }
        inbox -> new_inbox.

        return transaction::success [
            _return_data ($deferred -> deferred),
            _save_state NIL
        ].
    }

    // ---- local contact book ---------------------------------------------------
    // The book itself lives HOST-SIDE (wrapper-local file, remote peers have no
    // path to it) and stores only public address material — essentially a stored
    // multi-use invite. It bypasses invite generation/delivery, NOT the key
    // exchange: connecting still runs the normal encrypted_channel handshake.
    // Authorization is per attempt: the host's registrar packet mints a fresh,
    // short-lived, registrar-signed introduction credential for each connect, and
    // the target verifies it against its pinned registrar keys. An external peer
    // can never produce one, so the local boundary holds cryptographically.

    trn readonly export_address_document _
    {
        return (_write address_document::get_my_address_document()).
    }

    // control-protocol-to-MUFL: the NATIVE address-document record (NOT _write'd to a
    // bin). The daemon reads this from a freshly-provisioned child and passes it straight
    // back to ::a2a_cluster::register_provisioned_child, whose $child_ad is a native
    // t_address_document (it derives the child cid via child_ad $identity $container_id).
    // object_to_adapt_value round-trips the AdaptValue leaf through unchanged.
    trn readonly export_address_document_native _
    {
        return address_document::get_my_address_document().
    }

    // Export the root SIGN secret so the host can persist it (identity.key) and
    // reseed a recreated packet to the same address across upgrades (adapt #77).
    trn readonly export_signing_secret _
    {
        return key_storage::export_identity_signing_secret().
    }

    trn pin_registrar _:($registrar_ad -> registrar_ad_blob: bin, $replace -> replace: bool+)
    {
        current_transaction_info::validate_origin_or_abort (transaction::envelope::origin::user,).

        ad = (_read_or_abort registrar_ad_blob) safe address_document_types::t_address_document.
        if registrar_ad != NIL
        {
            // Idempotent re-pin of the same keys is a no-op; CHANGING the pinned
            // keys is a deliberate act and must be requested explicitly, so no
            // future internal-path code can substitute a registrar silently.
            if (_value_id (registrar_ad? $identity $key_list)) == (_value_id (ad $identity $key_list))
            {
                return transaction::success [
                    _return_data ($pinned -> TRUE, $changed -> FALSE)
                ].
            }
            abort "A different registrar key list is already pinned; pass $replace -> TRUE to overwrite." when replace == NIL || replace? != TRUE.
        }
        registrar_ad -> ad.
        return transaction::success [
            _return_data ($pinned -> TRUE, $changed -> TRUE),
            _save_state NIL
        ].
    }

    trn set_local_policy _:($auto_accept -> auto_accept: bool)
    {
        current_transaction_info::validate_origin_or_abort (transaction::envelope::origin::user,).
        local_auto_accept -> auto_accept.
        return transaction::success [
            _return_data ($auto_accept -> auto_accept),
            _save_state NIL
        ].
    }

    // Mint an introduction credential. Only meaningful on the host's REGISTRAR
    // packet: targets verify the signature against their pinned registrar keys,
    // so a credential minted by any other packet simply fails verification.
    // Stateless — nothing to save. iat is stamped with transaction time so mint
    // and verify use the same clock domain.
    trn mint_introduction _:($joiner_ad -> joiner_ad_blob: bin, $target_ad -> target_ad_blob: bin)
    {
        current_transaction_info::validate_origin_or_abort (transaction::envelope::origin::user,).

        joiner_ad = (_read_or_abort joiner_ad_blob) safe address_document_types::t_address_document.
        target_ad = (_read_or_abort target_ad_blob) safe address_document_types::t_address_document.
        intro is a2a_protocol::intro_t = (
            $version        -> 1,
            $joiner_cid     -> joiner_ad $identity $container_id,
            $joiner_ad_hash -> _value_id joiner_ad,
            $target_cid     -> target_ad $identity $container_id,
            $iat            -> (current_transaction_info::get_transaction_time())?,
            $nonce          -> _new_id "ours local introduction"
        ).
        signed is a2a_protocol::signed_intro_t = ($i -> intro, $s -> key_storage::default_sign (_value_id intro)).
        return transaction::success [
            _return_data ($intro -> (_write signed))
        ].
    }

    // Sign a contact-book entry (registrar packet only, same caveat as above).
    // Makes the host-side book file tamper-evident: senders re-derive this record
    // from the entry they read and verify the signature before connecting.
    trn sign_book_entry _:($name -> name: str, $ad -> ad_blob: bin)
    {
        current_transaction_info::validate_origin_or_abort (transaction::envelope::origin::user,).

        ad = (_read_or_abort ad_blob) safe address_document_types::t_address_document.
        entry is a2a_protocol::book_entry_t = ($version -> 1, $name -> name, $ad_hash -> _value_id ad).
        return transaction::success [
            _return_data ($sig -> (_write (key_storage::default_sign (_value_id entry))))
        ].
    }

    // Connect to a same-host peer found in the local contact book: verify the
    // book entry's registrar signature, register the peer as a contact, then
    // introduce myself over the encrypted channel — carrying the credential the
    // host just minted for this attempt, plus (optionally) the first message so
    // introduction + first delivery are one atomic transaction on the target
    // (no introduce-vs-message ordering race).
    trn connect_local _:($name -> name: str, $target_ad -> target_ad_blob: bin, $intro -> intro_blob: bin, $entry_sig -> entry_sig_blob: bin, $text -> text: str+)
    {
        current_transaction_info::validate_origin_or_abort (transaction::envelope::origin::user,).
        abort "No registrar pinned — the local contact book is unavailable for this identity." when registrar_ad == NIL.

        target_ad = (_read_or_abort target_ad_blob) safe address_document_types::t_address_document.
        target_id = target_ad $identity $container_id.
        abort "This contact-book entry is your own identity." when target_id == _get_container_id().

        entry is a2a_protocol::book_entry_t = ($version -> 1, $name -> name, $ad_hash -> _value_id target_ad).
        entry_sig = (_read_or_abort entry_sig_blob) safe crypto_signature.
        abort "Contact-book entry failed registrar verification." when key_storage::check_signature_new_container (_value_id entry) entry_sig (registrar_ad? $identity $key_list) != TRUE.

        a2a_messaging::contacts target_id -> ($name -> name, $container_id -> target_id).
        a2a_messaging::peer_ads target_id -> target_ad.

        my_self_name = a2a_messaging::my_name.
        my_ad = address_document::get_my_address_document().
        sent_date = (current_transaction_info::get_transaction_time())?.
        return encrypted_channel::execute_transaction target_id (fn (_) -> transaction::results::type {
            actions is transaction::action::type[] = [
                encrypted_channel::send_encrypted_tx target_id (
                    $name -> "::actor::local_introduce",
                    $targ -> ($joiner_name -> my_self_name, $joiner_ad -> my_ad, $intro -> intro_blob, $text -> text)
                )
            ].
            // FORCED monitoring copy of the carried first message (proxy-based), so a
            // local-book first send is monitored like every later send_message.
            if text != NIL
            {
                sc a2a_messaging::monitor_copy_actions "out" target_id sent_date text? -- ( -> a) { actions (_count actions|) -> a. }
            }
            actions (_count actions|) -> _return_data ($connected -> name, $container_id -> target_id).
            actions (_count actions|) -> _save_state NIL.
            return transaction::success actions.
        }).
    }

    trn approve_introduction _:($contact -> ref: str)
    {
        current_transaction_info::validate_origin_or_abort (transaction::envelope::origin::user,).

        pid = resolve_pending ref.
        entry = (pending_introductions pid)?.
        a2a_messaging::contacts pid -> ($name -> entry $name, $container_id -> pid).
        a2a_messaging::peer_ads pid -> entry $ad.

        queued = entry $messages.
        flushed is int = 0.
        sc queued -- ( -> m)
        {
            deposit_message pid (entry $name) (m $text) (m $date) "" no_reply.
            flushed -> flushed + 1.
        }
        delete pending_introductions pid.

        return transaction::success [
            _return_data ($approved -> entry $name, $container_id -> pid, $flushed -> flushed),
            _save_state NIL
        ].
    }

    trn reject_introduction _:($contact -> ref: str)
    {
        current_transaction_info::validate_origin_or_abort (transaction::envelope::origin::user,).

        pid = resolve_pending ref.
        entry = (pending_introductions pid)?.
        dropped = _count (entry $messages)|.
        delete pending_introductions pid.

        return transaction::success [
            _return_data ($rejected -> entry $name, $container_id -> pid, $dropped_messages -> dropped),
            _save_state NIL
        ].
    }

    trn readonly list_pending_introductions _
    {
        out is (global_id ->> pending_view_t) = (,).
        sc pending_introductions -- (cid -> p)
        {
            out cid -> ($name -> p $name, $queued -> _count (p $messages)|).
        }
        return out.
    }

    // ---- identity hierarchy ---------------------------------------------------
    // Two layers: one ROOT identity per host
    // (represents the person; structurally just a packet with no delegation
    // cert) and ROLE identities under it, each carrying a cert signed by the
    // root. The host drives issuance: it asks the root packet to sign a cert
    // (sign_delegation) and export its profile (export_root_profile), then
    // stores both into the role packet (set_delegation). Intra-root peers
    // (Ring 1) connect via connect_sibling/sibling_introduce with cert-based
    // auto-accept — no registrar credential, no approval queue, and it works
    // for roles that are not published in the local contact book.

    // Sign a delegation certificate for a role (meaningful on the ROOT packet:
    // verifiers check the signature against the root's keys, so a cert minted
    // by any other packet fails verification). Stateless — nothing to save.
    trn sign_delegation _:($role_ad -> role_ad_blob: bin, $role_id -> role_id: str)
    {
        current_transaction_info::validate_origin_or_abort (transaction::envelope::origin::user,).
        abort "Only a root identity can sign delegation certificates." when a2a_messaging::delegation_cert != NIL.

        role_ad = (_read_or_abort role_ad_blob) safe address_document_types::t_address_document.
        role_cid = role_ad $identity $container_id.
        abort "Cannot issue a delegation certificate to myself." when role_cid == _get_container_id().

        core is a2a_protocol::delegation_core_t = (
            $version      -> 1,
            $role_cid     -> role_cid,
            $role_ad_hash -> _value_id role_ad,
            $role_id      -> role_id,
            $root_cid     -> _get_container_id(),
            $issued_at    -> (current_transaction_info::get_transaction_time())?
        ).
        cert is a2a_protocol::delegation_cert_t = ($c -> core, $s -> key_storage::default_sign (_value_id core)).
        return transaction::success [
            _return_data ($cert -> (_write cert))
        ].
    }

    // Export my self-signed root profile (root packet only). Roles embed this
    // in the invites they generate, so external peers learn who is behind the
    // role; it carries my key list so the whole chain verifies standalone.
    trn export_root_profile _
    {
        current_transaction_info::validate_origin_or_abort (transaction::envelope::origin::user,).
        abort "Only a root identity can export a root profile." when a2a_messaging::delegation_cert != NIL.

        my_ad = address_document::get_my_address_document().
        core is a2a_protocol::root_profile_core_t = (
            $version  -> 1,
            $root_cid -> _get_container_id(),
            $name     -> a2a_messaging::my_name,
            $bio      -> a2a_messaging::my_bio,
            $keys     -> my_ad $identity $key_list
        ).
        profile is a2a_protocol::root_profile_t = ($p -> core, $s -> key_storage::default_sign (_value_id core)).
        return transaction::success [
            _return_data ($profile -> (_write profile))
        ].
    }

    // Store my delegation cert + root material (role packet, host-fired after
    // the root signed the cert). Everything is verified before it is stored:
    // a cert that does not name me, does not match my keys, or was not signed
    // by the carried root is rejected. Re-running with fresh material is the
    // refresh path (e.g. the root's bio changed -> new profile, same root).
    trn set_delegation _:($cert -> cert_blob: bin, $root_ad -> root_ad_blob: bin, $root_profile -> rp_blob: bin)
    {
        current_transaction_info::validate_origin_or_abort (transaction::envelope::origin::user,).

        cert = (_read_or_abort cert_blob) safe a2a_protocol::delegation_cert_t.
        new_root_ad = (_read_or_abort root_ad_blob) safe address_document_types::t_address_document.
        rp = (_read_or_abort rp_blob) safe a2a_protocol::root_profile_t.

        abort "Unsupported delegation certificate version." when (cert $c $version) != 1.
        abort "This delegation certificate was issued to a different identity." when (cert $c $role_cid) != _get_container_id().
        my_ad = address_document::get_my_address_document().
        abort "This delegation certificate does not match my address document." when (cert $c $role_ad_hash) != (_value_id my_ad).
        abort "The root address document does not match the certificate's root." when (new_root_ad $identity $container_id) != (cert $c $root_cid).
        abort "The delegation certificate was not signed by the root." when key_storage::check_signature_new_container (_value_id (cert $c)) (cert $s) (new_root_ad $identity $key_list) != TRUE.
        abort "Unsupported root profile version." when (rp $p $version) != 1.
        abort "The root profile does not match the certificate's root." when (rp $p $root_cid) != (cert $c $root_cid).
        abort "The root profile's key list does not match the root's address document." when (_value_id (rp $p $keys)) != (_value_id (new_root_ad $identity $key_list)).
        abort "The root profile signature is invalid." when key_storage::check_signature_new_container (_value_id (rp $p)) (rp $s) (new_root_ad $identity $key_list) != TRUE.

        a2a_messaging::delegation_cert -> cert.
        a2a_messaging::root_ad -> new_root_ad.
        a2a_messaging::root_profile -> rp.

        return transaction::success [
            _return_data ($delegated -> TRUE, $root_cid -> (_str (cert $c $root_cid)), $role_id -> cert $c $role_id),
            _save_state NIL
        ].
    }

    trn readonly describe_identity _
    {
        if a2a_messaging::delegation_cert == NIL
        {
            return ($name -> a2a_messaging::my_name, $bio -> a2a_messaging::my_bio, $persona -> a2a_messaging::my_persona, $has_cert -> FALSE, $role_id -> "", $root_cid -> "", $root_name -> "", $monitoring_enabled -> monitoring_enabled).
        }
        cert = a2a_messaging::delegation_cert?.
        rname is str = "".
        if a2a_messaging::root_profile != NIL { rname -> a2a_messaging::root_profile? $p $name. }
        return (
            $name      -> a2a_messaging::my_name,
            $bio       -> a2a_messaging::my_bio,
            $persona   -> a2a_messaging::my_persona,
            $has_cert  -> TRUE,
            $role_id   -> cert $c $role_id,
            $root_cid  -> (_str (cert $c $root_cid)),
            $root_name -> rname,
            $monitoring_enabled -> monitoring_enabled
        ).
    }

    // Connect to an intra-root sibling (Ring 1): register it as a contact and
    // introduce myself over the encrypted channel, presenting my delegation
    // cert (NIL when I am the root itself — the channel proves I control the
    // root's keys, which is all a role needs to recognize its root). Like
    // connect_local, the optional first message rides the introduction so
    // introduce + first delivery are one atomic transaction on the target.
    trn connect_sibling _:($name -> name: str, $target_ad -> target_ad_blob: bin, $text -> text: str+)
    {
        current_transaction_info::validate_origin_or_abort (transaction::envelope::origin::user,).

        target_ad = (_read_or_abort target_ad_blob) safe address_document_types::t_address_document.
        target_id = target_ad $identity $container_id.
        abort "This sibling is your own identity." when target_id == _get_container_id().

        cert_blob is bin+ = NIL.
        if a2a_messaging::delegation_cert != NIL { cert_blob -> (_write a2a_messaging::delegation_cert?). }

        a2a_messaging::contacts target_id -> ($name -> name, $container_id -> target_id).
        a2a_messaging::peer_ads target_id -> target_ad.
        // Record the target's root linkage: a sibling shares my root by
        // definition (the receiving side verifies the converse independently).
        if a2a_messaging::delegation_cert != NIL && a2a_messaging::root_profile != NIL
        {
            a2a_messaging::contact_roots target_id -> ($root_cid -> a2a_messaging::delegation_cert? $c $root_cid, $root_name -> a2a_messaging::root_profile? $p $name, $role_id -> name).
        }
        else
        {
            a2a_messaging::contact_roots target_id -> ($root_cid -> _get_container_id(), $root_name -> a2a_messaging::my_name, $role_id -> name).
        }

        my_self_name = a2a_messaging::my_name.
        my_ad = address_document::get_my_address_document().
        sent_date = (current_transaction_info::get_transaction_time())?.
        return encrypted_channel::execute_transaction target_id (fn (_) -> transaction::results::type {
            actions is transaction::action::type[] = [
                encrypted_channel::send_encrypted_tx target_id (
                    $name -> "::actor::sibling_introduce",
                    $targ -> ($joiner_name -> my_self_name, $joiner_ad -> my_ad, $cert -> cert_blob, $text -> text)
                )
            ].
            // FORCED monitoring copy of the carried first message (proxy-based), so an
            // intra-root first send is monitored like every later send_message.
            if text != NIL
            {
                sc a2a_messaging::monitor_copy_actions "out" target_id sent_date text? -- ( -> a) { actions (_count actions|) -> a. }
            }
            actions (_count actions|) -> _return_data ($connected -> name, $container_id -> target_id).
            actions (_count actions|) -> _save_state NIL.
            return transaction::success actions.
        }).
    }

    // ---- monitoring + control plane -------------------------------------------
    // A monitored ROLE reports
    // every message it sends/receives to its ROOT (the monitor_copy_actions
    // branches in the storage hooks above); the root queues the copies and the
    // host forwards them to a human proxy bound via 6-digit-code verification.
    // The proxy's control requests (create agent, update role, …) queue in
    // control_inbox and are executed by the host daemon.

    trn readonly get_monitoring_status _
    {
        pending is bool = FALSE.
        if proxy_pending != NIL { pending -> TRUE. }
        proxy_out is str = "".
        if monitoring_proxy != NIL { proxy_out -> _str (monitoring_proxy? $proxy_cid). }
        return (
            $monitoring_enabled -> monitoring_enabled,
            $proxy_cid          -> proxy_out,
            $proxy_pending      -> pending,
            $copies_queued      -> _count monitoring_inbox|,
            $control_queued     -> _count control_inbox|
        ).
    }

    // Sign a monitoring authorization for a role (ROOT packet only — the role
    // verifies the signature against its pinned root keys, so an auth minted
    // by any other packet fails). Stateless, mirrors sign_delegation.
    trn sign_monitoring_auth _:($role_ad -> role_ad_blob: bin, $enabled -> enabled: bool)
    {
        current_transaction_info::validate_origin_or_abort (transaction::envelope::origin::user,).
        abort "Only a root identity can sign monitoring authorizations." when a2a_messaging::delegation_cert != NIL.

        role_ad = (_read_or_abort role_ad_blob) safe address_document_types::t_address_document.
        core is monitoring_auth_core_t = (
            $version   -> 1,
            $role_cid  -> role_ad $identity $container_id,
            $enabled   -> enabled,
            $issued_at -> (current_transaction_info::get_transaction_time())?
        ).
        auth is monitoring_auth_t = ($c -> core, $s -> key_storage::default_sign (_value_id core)).
        return transaction::success [
            _return_data ($auth -> (_write auth))
        ].
    }

    // Store a verified monitoring flag (ROLE packet, host-fired after the root
    // signed the auth). An auth that does not name me or was not signed by my
    // root is rejected — so even a compromised host process cannot silently
    // flip monitoring without the root packet's keys.
    trn set_monitoring _:($auth -> auth_blob: bin)
    {
        current_transaction_info::validate_origin_or_abort (transaction::envelope::origin::user,).
        abort "Only a delegated role can be monitored." when a2a_messaging::delegation_cert == NIL || a2a_messaging::root_ad == NIL.

        auth = (_read_or_abort auth_blob) safe monitoring_auth_t.
        abort "Unsupported monitoring authorization version." when (auth $c $version) != 1.
        abort "This monitoring authorization was issued to a different identity." when (auth $c $role_cid) != _get_container_id().
        abort "The monitoring authorization was not signed by my root." when key_storage::check_signature_new_container (_value_id (auth $c)) (auth $s) (a2a_messaging::root_ad? $identity $key_list) != TRUE.

        monitoring_enabled -> auth $c $enabled.
        return transaction::success [
            _return_data ($monitoring_enabled -> monitoring_enabled),
            _save_state NIL
        ].
    }

    // A monitored role reports one message copy (ROOT packet, inbound). Only
    // accepted from a verified role of THIS root (the contact_roots linkage
    // recorded by sibling_introduce), and the copy must name its actual sender
    // — a role cannot forge copies on another role's behalf.
    trn receive_monitoring_copy _:($copy -> copy: monitoring_copy_t)
    {
        current_transaction_info::validate_origin_or_abort (transaction::envelope::origin::external,).
        encrypted_channel::check_encrypted_or_abort().

        sender_id = current_transaction_info::get_external_envelope_or_abort() $from.
        link = a2a_messaging::contact_roots sender_id.
        abort "Monitoring copies are only accepted from my own roles." when link == NIL || (link? $root_cid) != _get_container_id().
        abort "Monitoring copy does not name its sender as the source." when (copy $source_cid) != sender_id.
        abort "Unsupported monitoring copy version." when (copy $version) != 1.

        // Capped queue, oldest first out: if no proxy drains the root, recent
        // traffic wins over old.
        if (_count monitoring_inbox|) >= monitoring_inbox_cap
        {
            trimmed is monitoring_copy_t[] = [].
            i is int = 0.
            sc monitoring_inbox -- ( -> m)
            {
                if i > 0 { trimmed (_count trimmed|) -> m. }
                i -> i + 1.
            }
            monitoring_inbox -> trimmed.
        }
        monitoring_inbox (_count monitoring_inbox|) -> copy.

        return transaction::success [
            _notify_agent ($event -> $monitoring_copy, $source_name -> copy $source_name, $queued -> _count monitoring_inbox|),
            _save_state NIL
        ].
    }

    // Drain the queued monitoring copies (ROOT packet, host-fired before
    // forwarding to the bound proxy). Cleared on read, like get_messages.
    trn get_monitoring_copies _
    {
        current_transaction_info::validate_origin_or_abort (transaction::envelope::origin::user,).

        copies = monitoring_inbox.
        monitoring_inbox -> [].
        return transaction::success [
            _return_data ($copies -> copies),
            _save_state NIL
        ].
    }

    // Drain the queued control requests (ROOT packet, host-fired by the
    // control dispatcher). Cleared on read.
    trn get_control_requests _
    {
        current_transaction_info::validate_origin_or_abort (transaction::envelope::origin::user,).

        reqs = control_inbox.
        control_inbox -> [].
        return transaction::success [
            _return_data ($requests -> reqs),
            _save_state NIL
        ].
    }

    // control-protocol-to-MUFL seam: the daemon adapts each queued control payload
    // (opaque JSON string) into a native control_envelope_t record and fires THIS trn
    // (origin::user, host-only — the in-dispatch RR-9 authz gate, keyed on $sender_id
    // not origin, is the security boundary). a2a_capabilities::dispatch runs that gate
    // then routes to the capability handler; the handler's action[] carries the
    // response_envelope as a $data return_data (daemon marshals + ships it to the
    // sender) plus, for async verbs, host_* notify-actions the daemon's host executor
    // consumes. ALL inbound control flows through here — no per-verb side path (C8).
    trn process_control_envelope _:(
        $sender_id   -> sender_id: global_id,
        $sender_name -> sender_name: str,
        $envelope    -> env: any,
        $date        -> date: time
    )
    {
        current_transaction_info::validate_origin_or_abort (transaction::envelope::origin::user,).
        return transaction::success (
            a2a_capabilities::dispatch (
                $sender_id   -> sender_id,
                $sender_name -> sender_name,
                $app_id      -> "network.ours.mcp",
                $envelope    -> env,
                $date        -> date
            )
        ).
    }

    // Start a proxy binding (ROOT packet, host-fired): remember the code the
    // host generated (MUFL has no random source) for one specific contact.
    // Restarting overwrites any previous pending binding.
    trn set_proxy_pending _:($code -> code: str, $proxy -> proxy_ref: str)
    {
        current_transaction_info::validate_origin_or_abort (transaction::envelope::origin::user,).
        abort "Only a root identity can bind a monitoring proxy." when a2a_messaging::delegation_cert != NIL.

        pid = a2a_messaging::resolve_contact proxy_ref.
        proxy_pending -> (
            $code       -> code,
            $proxy_cid  -> pid,
            $created_at -> (current_transaction_info::get_transaction_time())?,
            $attempts   -> 0
        ).
        return transaction::success [
            _return_data ($pending -> TRUE, $proxy_cid -> (_str pid)),
            _save_state NIL
        ].
    }

    // Verify a proxy's code attempt (ROOT packet, host-fired when a `bind`
    // control request arrives). Failures are returned as DATA — not aborts —
    // so the attempt counter and expiry clearing persist atomically; an abort
    // would roll them back and reopen the brute-force window.
    trn verify_proxy_code _:($code -> code: str, $sender -> sender_ref: str)
    {
        current_transaction_info::validate_origin_or_abort (transaction::envelope::origin::user,).

        if proxy_pending == NIL
        {
            return transaction::success [ _return_data ($verified -> FALSE, $reason -> "no_pending") ].
        }
        p = proxy_pending?.
        now = (current_transaction_info::get_transaction_time())?.

        if (_substract_seconds now (p $created_at)) > proxy_code_max_age_seconds
        {
            proxy_pending -> NIL.
            return transaction::success [
                _return_data ($verified -> FALSE, $reason -> "expired"),
                _save_state NIL
            ].
        }

        sid = a2a_messaging::resolve_contact sender_ref.
        if sid != (p $proxy_cid)
        {
            // Not the contact this binding was started for: reject without
            // burning an attempt (the code was never compared).
            return transaction::success [ _return_data ($verified -> FALSE, $reason -> "wrong_sender") ].
        }

        if code != (p $code)
        {
            attempts = (p $attempts) + 1.
            if attempts >= proxy_max_attempts
            {
                proxy_pending -> NIL.
                return transaction::success [
                    _return_data ($verified -> FALSE, $reason -> "too_many_attempts"),
                    _save_state NIL
                ].
            }
            proxy_pending -> (
                $code       -> p $code,
                $proxy_cid  -> p $proxy_cid,
                $created_at -> p $created_at,
                $attempts   -> attempts
            ).
            return transaction::success [
                _return_data ($verified -> FALSE, $reason -> "wrong_code", $attempts_left -> proxy_max_attempts - attempts),
                _save_state NIL
            ].
        }

        monitoring_proxy -> ($proxy_cid -> sid, $bound_at -> now).
        proxy_pending -> NIL.
        return transaction::success [
            _return_data ($verified -> TRUE, $proxy_cid -> (_str sid)),
            _save_state NIL
        ].
    }

    // Drop the proxy binding (and any in-flight code verification).
    trn clear_monitoring_proxy _
    {
        current_transaction_info::validate_origin_or_abort (transaction::envelope::origin::user,).

        monitoring_proxy -> NIL.
        proxy_pending -> NIL.
        return transaction::success [
            _return_data ($cleared -> TRUE),
            _save_state NIL
        ].
    }

    // ---- upgrade: state export / import -------------------------------------
    // The host persists state by calling export_state (readonly) and serializing
    // the returned value to a code-independent blob. On a code upgrade it also
    // persists the root SIGN secret (export_signing_secret) and recreates the
    // packet with that secret injected as init_arg; __init reseeds the identity
    // from it (reseed_identity_from_secret), which preserves the container
    // address regardless of the seed phrase or key-derivation used to recreate
    // the packet. The blob is then replayed through import_state.
    //
    // The packet-level snapshot is NOT used for upgrades: it is bound to the unit
    // code hash, so a new .muflo cannot load an old snapshot. This data blob is.
    //
    // The blob stays FLAT with the historical field names — the core fields come
    // from a2a_messaging::export_core_state / import_core_state, the app fields
    // are composed in here — so a PRE-migration export imports unchanged.

    trn readonly export_state _
    {
        // Core (contact / profile / hierarchy / cluster / forced-monitoring) state
        // is namespaced under $core: export_core_state owns its OWN field set, so any
        // field the shared core adds (core 2.1 added root_cp_binding, managed_roots,
        // contact_cp_bindings, app_config) is carried forward automatically, and the
        // core's monitoring keys (proxy_pending/monitoring_proxy) never collide with
        // the APP-level monitoring keys we still own below — they share both names AND
        // shapes. The blob stays code-independent; import_state migrates the
        // pre-namespacing FLAT shape forward (see there).
        return (
            $app_format_version -> 1,
            $core              -> a2a_messaging::export_core_state NIL,
            // ---- app-owned state (agent inbox + local contact book) ----
            $inbox             -> inbox,
            $next_msg_seq      -> next_msg_seq,
            $files             -> files,
            $next_file_seq     -> next_file_seq,
            $registrar_ad      -> registrar_ad,
            $local_auto_accept -> local_auto_accept,
            // Nonces are exported so a restart does not reopen the replay window
            // for still-fresh credentials; stale ones are purged lazily anyway.
            $seen_nonces       -> seen_nonces,
            $pending_introductions -> pending_introductions,
            // App-level (role->root) monitoring — a DISTINCT mechanism from core's
            // forced monitoring. Stays app-owned and top-level; it must NEVER be fed
            // into import_core_state (that would arm core's hidden monitoring_proxy,
            // which the app cannot disarm). See import_state's legacy branch.
            $monitoring_enabled -> monitoring_enabled,
            $monitoring_inbox  -> monitoring_inbox,
            $proxy_pending     -> proxy_pending,
            $monitoring_proxy  -> monitoring_proxy,
            $control_inbox     -> control_inbox
        ).
    }

    trn import_state data: any
    {
        current_transaction_info::validate_origin_or_abort (transaction::envelope::origin::user,).

        // App-level format stamp (absent == 0, every pre-stamp blob). Same contract
        // as the core stamp (see a2a_messaging::import_core_state): additive fields
        // stay optional reads; a future BREAKING app-blob change dispatches here.
        app_fmt is int = 0.
        if (data $app_format_version) != NIL { app_fmt -> (data $app_format_version) safe int. }
        abort "App state blob format_version " + (_str app_fmt) + " is newer than this code (supports up to 1) — upgrade ours-mcp before importing." when app_fmt > 1.

        // Core (contact/profile/hierarchy/cluster) state — validated and restored by
        // the shared library, which also replays every peer's address document
        // through process_address_document so encrypted channels keep working after
        // the upgrade with no re-handshake. The current export namespaces it under
        // $core, so the core owns its own field set and its monitoring keys never
        // collide with the app's. A PRE-namespacing FLAT blob carries the core fields
        // at the top level — migrate it by feeding import_core_state ONLY the genuine
        // shared fields. We deliberately OMIT proxy_pending / monitoring_proxy on the
        // legacy path: in a flat blob those keys hold the APP-level monitoring state
        // (same names AND shapes as core's), and feeding them to import_core_state
        // would arm core's hidden forced-monitoring proxy — which the app can NEVER
        // disarm (hidden state; disable_monitoring is external-CP-origin only).
        // root_cp_binding / managed_roots / contact_cp_bindings / app_config never
        // existed in flat blobs, so they are absent here → core defaults (dormant).
        if (data $core) != NIL
        {
            a2a_messaging::import_core_state (data $core).
        }
        else
        {
            a2a_messaging::import_core_state (
                $my_name         -> data $my_name,
                $contacts        -> data $contacts,
                $pending_invites -> data $pending_invites,
                $peer_ads        -> data $peer_ads,
                $my_bio          -> data $my_bio,
                $delegation_cert -> data $delegation_cert,
                $root_ad         -> data $root_ad,
                $root_profile    -> data $root_profile,
                $contact_roots   -> data $contact_roots
            ).
        }

        // The inbox + next_msg_seq are the only parts the message-lifecycle changes
        // touched. A pre-lifecycle blob has no $next_msg_seq and inbox entries with
        // no id/status — MIGRATE it forward (the whole point of code-independent
        // state is that an old export upgrades, never resets): assign each legacy
        // message a sequential id and status "unread", and seed next_msg_seq past
        // them. A current-shape blob is loaded as-is except the gc vocabulary bump
        // ("read" -> "processed", see below).
        if (data $next_msg_seq) == NIL
        {
            legacy_inbox = (data $inbox) safe (legacy_message_t[]).
            migrated is message_t[] = [].
            seq is int = 1.
            sc legacy_inbox -- ( -> m)
            {
                migrated (_count migrated|) -> (
                    $msg_id      -> seq,
                    $sender_id   -> m $sender_id,
                    $sender_name -> m $sender_name,
                    $text        -> m $text,
                    $date        -> m $date,
                    $status      -> "unread",
                    $wire_id     -> "",
                    $reply_to    -> NIL
                ).
                seq -> seq + 1.
            }
            inbox        -> migrated.
            next_msg_seq -> seq.
        }
        else
        {
            // Current-shape blob, read field-by-field (NOT a strict message_t[]
            // cast) so a pre-1.4 blob — whose messages have no $wire_id/$reply_to
            // — imports without aborting on the now-required $wire_id. Two
            // forward-migrations: the old "read" status -> "processed" (else the
            // message is stuck: never returned, gc'd, or deferred), and absent
            // wire_id/reply_to default to "" / NIL.
            upgraded is message_t[] = [].
            sc (data $inbox) -- ( -> m)
            {
                mstatus = (((m $status) safe str) == "read" ?? "processed" ; (m $status) safe str).
                mwire is str = "".
                if (m $wire_id) != NIL { mwire -> (m $wire_id) safe str. }
                mreply is a2a_protocol::reply_ref_t+ = NIL.
                if (m $reply_to) != NIL { mreply -> (m $reply_to) safe a2a_protocol::reply_ref_t. }
                upgraded (_count upgraded|) -> (
                    $msg_id      -> (m $msg_id) safe int,
                    $sender_id   -> (m $sender_id) safe global_id,
                    $sender_name -> (m $sender_name) safe str,
                    $text        -> (m $text) safe str,
                    $date        -> (m $date) safe time,
                    $status      -> mstatus,
                    $wire_id     -> mwire,
                    $reply_to    -> mreply
                ).
            }
            inbox        -> upgraded.
            next_msg_seq -> (data $next_msg_seq) safe int.
        }

        // File store arrived in this version — optional in older blobs; defaults
        // (empty store, seq 1) stay in place when absent. Read field-by-field so a
        // future field addition does not abort a strict cast.
        if (data $files) != NIL
        {
            restored_files is file_t[] = [].
            sc (data $files) -- ( -> f)
            {
                fwire is str = "".
                if (f $wire_id) != NIL { fwire -> (f $wire_id) safe str. }
                freply is a2a_protocol::reply_ref_t+ = NIL.
                if (f $reply_to) != NIL { freply -> (f $reply_to) safe a2a_protocol::reply_ref_t. }
                restored_files (_count restored_files|) -> (
                    $file_id     -> (f $file_id) safe int,
                    $sender_id   -> (f $sender_id) safe global_id,
                    $sender_name -> (f $sender_name) safe str,
                    $filename    -> (f $filename) safe str,
                    $mime        -> (f $mime) safe str,
                    $data        -> (f $data) safe bin,
                    $date        -> (f $date) safe time,
                    $status      -> (f $status) safe str,
                    $wire_id     -> fwire,
                    $reply_to    -> freply
                ).
            }
            files -> restored_files.
        }
        if (data $next_file_seq) != NIL
        {
            next_file_seq -> (data $next_file_seq) safe int.
        }

        // Local-contact-book state arrived after the original schema — every
        // field is optional in old blobs and defaults stay in place when absent.
        if (data $registrar_ad) != NIL
        {
            registrar_ad -> (data $registrar_ad) safe address_document_types::t_address_document.
        }
        if (data $local_auto_accept) != NIL
        {
            local_auto_accept -> (data $local_auto_accept) safe bool.
        }
        if (data $seen_nonces) != NIL
        {
            seen_nonces -> (data $seen_nonces) safe (global_id ->> time).
        }
        if (data $pending_introductions) != NIL
        {
            pending_introductions -> (data $pending_introductions) safe (global_id ->> pending_intro_t).
        }

        // Monitoring + control state arrived after the local-book schema —
        // optional in old blobs the same way.
        if (data $monitoring_enabled) != NIL
        {
            monitoring_enabled -> (data $monitoring_enabled) safe bool.
        }
        if (data $monitoring_inbox) != NIL
        {
            monitoring_inbox -> (data $monitoring_inbox) safe (monitoring_copy_t[]).
        }
        if (data $proxy_pending) != NIL
        {
            proxy_pending -> (data $proxy_pending) safe proxy_pending_t.
        }
        if (data $monitoring_proxy) != NIL
        {
            monitoring_proxy -> (data $monitoring_proxy) safe proxy_binding_t.
        }
        if (data $control_inbox) != NIL
        {
            control_inbox -> (data $control_inbox) safe (control_req_t[]).
        }

        // Pending introducers' keys too: their channel to me predates approval,
        // so it must survive an upgrade exactly like an approved contact's.
        sc pending_introductions -- ( -> p)
        {
            address_document::process_address_document (p $ad) TRUE.
        }

        return transaction::success [
            _return_data ($imported -> TRUE, $contacts -> _count a2a_messaging::contacts|, $peers -> _count a2a_messaging::peer_ads|),
            _save_state NIL
        ].
    }

    // ---- external (inbound) transactions ------------------------------------

    // Compat shims (Option A): pre-migration peers address these as ::actor::*,
    // and the core keeps SENDING to the ::actor:: names too. Each delegates to
    // the shared handler — remove only when no old clients remain.
    trn accept_contact args: any
    {
        return a2a_messaging::handle_accept_contact args.
    }

    trn receive_message args: any
    {
        return a2a_messaging::handle_receive_message args.
    }

    // A same-host peer connects via the local contact book. The credential must
    // have been minted by THIS HOST's registrar for THIS sender and THIS target,
    // recently, and never seen before — five checks that together make the book
    // path unusable from outside the host:
    //   1. registrar signature over the credential (pinned key list)
    //   2. envelope $from == credential.joiner_cid   (no splicing someone
    //      else's credential onto your own channel)
    //   3. hash(joiner_ad) == credential.joiner_ad_hash (no AD substitution)
    //   4. credential.target_cid == me               (no cross-target reuse)
    //   5. freshness window + unseen nonce           (no replay)
    // The encrypted channel itself authenticates that the sender controls its
    // keys, so no extra challenge-response is needed.
    trn local_introduce _:($joiner_name -> joiner_name: str, $joiner_ad -> joiner_ad: address_document_types::t_address_document, $intro -> intro_blob: bin, $text -> text: str+)
    {
        current_transaction_info::validate_origin_or_abort (transaction::envelope::origin::external,).
        encrypted_channel::check_encrypted_or_abort().

        sender_id = current_transaction_info::get_external_envelope_or_abort() $from.
        abort "This identity does not accept local-contact-book introductions." when registrar_ad == NIL.

        signed = (_read_or_abort intro_blob) safe a2a_protocol::signed_intro_t.
        intro = signed $i.
        abort "Unsupported introduction credential version." when (intro $version) != 1.
        abort "Introduction credential was not signed by this host's registrar." when key_storage::check_signature_new_container (_value_id intro) (signed $s) (registrar_ad? $identity $key_list) != TRUE.
        abort "Introduction credential was minted for a different sender." when (intro $joiner_cid) != sender_id.
        abort "Introduction credential does not match the sender's address document." when (intro $joiner_ad_hash) != _value_id joiner_ad.
        abort "Introduction credential targets a different identity." when (intro $target_cid) != _get_container_id().

        now = (current_transaction_info::get_transaction_time())?.
        age = _substract_seconds now (intro $iat).
        abort "Introduction credential is outside its freshness window." when age > intro_max_age_seconds || age < (0 - intro_max_skew_seconds).

        // Lazy nonce GC (drop everything past the retention horizon), then the
        // replay check, then a hard cap so a misbehaving local peer cannot bloat
        // packet state inside the window.
        horizon = intro_max_age_seconds + intro_max_skew_seconds.
        fresh_nonces is (global_id ->> time) = (,).
        sc seen_nonces -- (n -> t)
        {
            if (_substract_seconds now t) <= horizon { fresh_nonces n -> t. }
        }
        seen_nonces -> fresh_nonces.
        abort "Replayed introduction credential." when seen_nonces (intro $nonce) != NIL.
        abort "Too many concurrent introductions; try again shortly." when (_count seen_nonces|) >= seen_nonce_cap.
        seen_nonces (intro $nonce) -> now.

        existing = a2a_messaging::contacts sender_id.
        if existing != NIL
        {
            // Already a contact (idempotent re-introduction): keep my assigned
            // name, refresh the stored address document, deliver any payload.
            a2a_messaging::peer_ads sender_id -> joiner_ad.
            if text != NIL
            {
                mid = deposit_message sender_id (existing? $name) text? now "" no_reply.
                actions is transaction::action::type[] = [
                    _notify_agent ($event -> $message_received, $sender_name -> existing? $name, $msg_id -> mid, $date -> now)
                ].
                // FORCED monitoring copy: an internal first-contact delivery is still a
                // received message and must reach the bound control plane (proxy-based).
                sc a2a_messaging::monitor_copy_actions "in" sender_id now text? -- ( -> a) { actions (_count actions|) -> a. }
                actions (_count actions|) -> _save_state NIL.
                return transaction::success actions.
            }
            return transaction::success [ _save_state NIL ].
        }

        if local_auto_accept
        {
            a2a_messaging::contacts sender_id -> ($name -> joiner_name, $container_id -> sender_id).
            a2a_messaging::peer_ads sender_id -> joiner_ad.
            if text != NIL
            {
                mid = deposit_message sender_id joiner_name text? now "" no_reply.
                actions is transaction::action::type[] = [
                    _notify_agent ($event -> $local_contact_added, $name -> joiner_name, $container_id -> sender_id),
                    _notify_agent ($event -> $message_received, $sender_name -> joiner_name, $msg_id -> mid, $date -> now)
                ].
                sc a2a_messaging::monitor_copy_actions "in" sender_id now text? -- ( -> a) { actions (_count actions|) -> a. }
                actions (_count actions|) -> _save_state NIL.
                return transaction::success actions.
            }
            return transaction::success [
                _notify_agent ($event -> $local_contact_added, $name -> joiner_name, $container_id -> sender_id),
                _save_state NIL
            ].
        }

        // Pending-approval policy: park the introduction (with its optional
        // first message) until approve_introduction / reject_introduction.
        queued is pending_msg_t[] = [].
        if text != NIL { queued 0 -> ($text -> text?, $date -> now). }
        pending_introductions sender_id -> ($name -> joiner_name, $ad -> joiner_ad, $messages -> queued).
        return transaction::success [
            _notify_agent ($event -> $local_contact_request, $name -> joiner_name, $container_id -> sender_id, $queued -> _count queued|),
            _save_state NIL
        ].
    }

    // An intra-root peer connects (Ring 1 of the identity hierarchy). Trust is
    // the delegation cert, not a registrar credential: the sender presents a
    // cert that must (a) name MY root, (b) verify against my root's keys,
    // (c) name the sender as the role, and (d) match the sender's address
    // document. The encrypted channel authenticates that the sender controls
    // its keys, and a cert is useless on anyone else's channel because of (c) —
    // so no nonce/freshness machinery is needed; the cert is a standing
    // credential, revoked by deleting the role (the root simply stops vouching).
    // A cert-less introduction is accepted ONLY from my root itself (the root
    // has no cert; the channel proves it controls the root's keys).
    // Intra-root introductions auto-accept regardless of local_auto_accept —
    // implicit trust inside the root is the point of Ring 1.
    trn sibling_introduce _:($joiner_name -> joiner_name: str, $joiner_ad -> joiner_ad: address_document_types::t_address_document, $cert -> cert_blob: bin+, $text -> text: str+)
    {
        current_transaction_info::validate_origin_or_abort (transaction::envelope::origin::external,).
        encrypted_channel::check_encrypted_or_abort().

        sender_id = current_transaction_info::get_external_envelope_or_abort() $from.
        now = (current_transaction_info::get_transaction_time())?.

        link is a2a_protocol::contact_root_t+ = NIL.
        if cert_blob == NIL
        {
            // Sender claims to be my root.
            abort "A certificate-less sibling introduction is only accepted from my root." when a2a_messaging::delegation_cert == NIL.
            abort "Sender is not my root." when sender_id != (a2a_messaging::delegation_cert? $c $root_cid).
            link -> ($root_cid -> sender_id, $root_name -> joiner_name, $role_id -> "").
        }
        else
        {
            cert = (_read_or_abort cert_blob?) safe a2a_protocol::delegation_cert_t.
            abort "Unsupported delegation certificate version." when (cert $c $version) != 1.
            abort "Sibling certificate was issued for a different sender." when (cert $c $role_cid) != sender_id.
            abort "Sibling certificate does not match the sender's address document." when (cert $c $role_ad_hash) != (_value_id joiner_ad).

            root_name_known is str = "".
            if a2a_messaging::delegation_cert != NIL
            {
                // I am a role: the cert must name MY root and verify against the
                // root key material pinned at delegation time.
                abort "My root material is missing — cannot verify sibling certificates." when a2a_messaging::root_ad == NIL.
                abort "Sibling certificate names a different root." when (cert $c $root_cid) != (a2a_messaging::delegation_cert? $c $root_cid).
                abort "Sibling certificate was not signed by my root." when key_storage::check_signature_new_container (_value_id (cert $c)) (cert $s) (a2a_messaging::root_ad? $identity $key_list) != TRUE.
                if a2a_messaging::root_profile != NIL { root_name_known -> a2a_messaging::root_profile? $p $name. }
            }
            else
            {
                // I have no cert: I only accept certs that *I* issued, i.e. I am
                // the root. A legacy flat identity fails this check by design.
                abort "Sibling certificate names a different root." when (cert $c $root_cid) != _get_container_id().
                my_ad = address_document::get_my_address_document().
                abort "Sibling certificate was not signed by me." when key_storage::check_signature_new_container (_value_id (cert $c)) (cert $s) (my_ad $identity $key_list) != TRUE.
                root_name_known -> a2a_messaging::my_name.
            }
            link -> ($root_cid -> cert $c $root_cid, $root_name -> root_name_known, $role_id -> cert $c $role_id).
        }

        existing = a2a_messaging::contacts sender_id.
        if existing != NIL
        {
            // Already a contact (idempotent re-introduction): keep my assigned
            // name, refresh the stored material, deliver any payload.
            a2a_messaging::peer_ads sender_id -> joiner_ad.
            a2a_messaging::contact_roots sender_id -> link?.
            if text != NIL
            {
                mid = deposit_message sender_id (existing? $name) text? now "" no_reply.
                actions is transaction::action::type[] = [
                    _notify_agent ($event -> $message_received, $sender_name -> existing? $name, $msg_id -> mid, $date -> now)
                ].
                // FORCED monitoring copy: an internal first-contact delivery is still a
                // received message and must reach the bound control plane (proxy-based).
                sc a2a_messaging::monitor_copy_actions "in" sender_id now text? -- ( -> a) { actions (_count actions|) -> a. }
                actions (_count actions|) -> _save_state NIL.
                return transaction::success actions.
            }
            return transaction::success [ _save_state NIL ].
        }

        a2a_messaging::contacts sender_id -> ($name -> joiner_name, $container_id -> sender_id).
        a2a_messaging::peer_ads sender_id -> joiner_ad.
        a2a_messaging::contact_roots sender_id -> link?.
        if text != NIL
        {
            mid = deposit_message sender_id joiner_name text? now "" no_reply.
            actions is transaction::action::type[] = [
                _notify_agent ($event -> $sibling_contact_added, $name -> joiner_name, $container_id -> sender_id),
                _notify_agent ($event -> $message_received, $sender_name -> joiner_name, $msg_id -> mid, $date -> now)
            ].
            sc a2a_messaging::monitor_copy_actions "in" sender_id now text? -- ( -> a) { actions (_count actions|) -> a. }
            actions (_count actions|) -> _save_state NIL.
            return transaction::success actions.
        }
        return transaction::success [
            _notify_agent ($event -> $sibling_contact_added, $name -> joiner_name, $container_id -> sender_id),
            _save_state NIL
        ].
    }
}
