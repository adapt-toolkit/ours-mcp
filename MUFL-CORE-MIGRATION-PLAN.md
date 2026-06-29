# MUFL Core Migration Plan

Move the shared transaction logic from the two app packets into the
`ours-mufl-core` shared library (git submodule at `<app>/mufl_code/core/`),
so any client gets the full ours transaction set by loading the core
libraries.

**Scope of THIS migration: code movement only — wire-compatible, no protocol
changes.** Extensibility rails (versioned message record, version exchange)
and new features (groups, replies, attachments) are documented below but
DEFERRED to later phases.

## Consumers

| App | Packet source | Host |
|-----|--------------|------|
| MCP agent | `ours-mcp/plugin/mufl_code/actor.mu` (1338 lines) | `plugin/src/index.ts` (addresses trns as `::actor::<name>`) |
| Web messenger | `messenger/mufl_code/messenger.mu` (506 lines) | web host |

~70% of messenger.mu is a verbatim/near-verbatim copy of actor.mu.

## Key platform facts (verified)

- **MUFL libraries can declare `trn` and own mutable state.** Stdlib precedent:
  `address_document` (declares `register_container`, `handshake`, ... and holds
  `m_my_address_document`), `encrypted_channel` (`authorize_packet`),
  `continuation` (addressed on the wire as `::continuation::continue_transaction`).
- Library transactions are routed as `::<library>::<trn>`.
- Only **4 transaction names are network-visible** (embedded in what peers send):
  `::actor::accept_contact`, `::actor::receive_message`,
  `::actor::local_introduce`, `::actor::sibling_introduce`.
  Every other `::actor::*` name lives in the host (TS/web), which ships together
  with its packet — renaming those is a coordinated app change, not a network break.
- Moving shapes/code between libraries does not change wire bytes (shapes are
  consumed structurally — see core README compatibility rules).

## Locked decisions

1. **Message storage stays APP-SIDE.** Core handles wire + validation + contact
   resolution and delegates storage through init-injected hooks (same pattern as
   `key_storage::init ($_read_or_abort -> ...)`). The agent keeps its inbox
   lifecycle (unread/processed/gc), the messenger keeps per-contact history.
   No `a2a_inbox` core module for now.
2. **Option A backward compat:** each app keeps 4 one-line `::actor::` delegating
   `trn` shims for the network-visible inbound transactions, AND the core keeps
   **sending** to the `::actor::` names (export them as constants from core).
   Zero network break. The shims get removed in a future version once no old
   clients remain.
3. Host-facing (user-origin) transactions move to library routing
   (`::a2a_messaging::<name>` etc.); each host updates its transaction-name
   strings in the same release as its packet.

## Target core layout (`ours-mufl-core` repo)

```
core/
  version.mm           (existing — bump MIN for this migration)
  a2a_protocol.mm      (existing — wire shapes + verification, unchanged)
  a2a_messaging.mm     (NEW — shared state + core transactions + init hooks)
  a2a_hierarchy.mm     (NEW — identity-hierarchy transactions)
  a2a_local_book.mm    (NEW — optional module: registrar / local contact book)
  config.mufl          (export the new libraries)
```

### a2a_messaging.mm

State (moves out of both apps):
`my_name`, `my_bio`, `contacts`, `pending_invites`, `peer_ads`, `contact_roots`,
plus delegation material (`delegation_cert`, `root_ad`, `root_profile` — needed
by `generate_invite`/`add_contact` role branches; the hierarchy *transactions*
live in a2a_hierarchy.mm but share this state, so either expose accessors or
put the state here and have a2a_hierarchy load a2a_messaging).

Helpers (move as-is): `resolve_contact`, `_save_state` / `_return_data` /
`_notify_agent` action builders, `_read_or_abort` wiring.

Init hooks (injected by each app in its hidden block):
- `$_read_or_abort` (existing pattern)
- `$on_message_received (sender_id, sender_name, text, date) -> actions`
  — agent: deposit into inbox (+ pending-introduction queueing path);
  messenger: append_history "in"
- `$on_message_sent (target_id, text, date)` — agent: no-op; messenger:
  append_history "out"
- `$on_contact_removed (cid)` — agent: no-op; messenger: delete history

Transactions (Tier 1 — verbatim lifts; Tier 2 — message path behind hooks):
- `set_my_name`, `set_my_bio`
- `generate_invite` (FULL version incl. role-invite branch — messenger gains it
  for free since its `delegation_cert` is NIL)
- `add_contact` (agent version is the superset: also sends own cert in reply;
  unify on it — wire-safe because receivers take `any`)
- `send_message` (wire part; calls `on_message_sent`)
- `remove_contact` (calls `on_contact_removed`)
- `list_contacts`, `list_contact_roots`, `get_version`
- inbound `accept_contact` (already byte-identical in both apps)
- inbound `receive_message` (validation; calls `on_message_received`)
- `export_core_state` / `import_core_state` helper FNS (not trns) covering the
  shared state fields, for the apps' export/import wrappers to compose

### a2a_hierarchy.mm

`sign_delegation`, `export_root_profile`, `set_delegation`, `describe_identity`,
`connect_sibling`, inbound `sibling_introduce`. Messenger may load this (gains
full hierarchy ability) or skip it for now — decide at integration time;
loading it is the simpler default.

### a2a_local_book.mm (optional module — agent loads it, messenger does NOT)

`pin_registrar`, `set_local_policy`, `mint_introduction`, `sign_book_entry`,
`connect_local`, `approve_introduction`, `reject_introduction`,
`list_pending_introductions`, inbound `local_introduce`.
State: `registrar_ad`, `local_auto_accept`, `seen_nonces`,
`pending_introductions` + the pending_intro/pending_msg shapes and caps.
Note: its `receive_message` interplay (pending-introduction message queue) is
wired through the agent's `on_message_received` hook, keeping a2a_messaging
free of local-book knowledge.

## What stays in each app

**actor.mu (agent):**
- Message store: `message_t`, inbox, `next_msg_seq`, `deposit_message`,
  `get_messages`, `defer_messages`, `gc`, `list_incoming_messages`
- `export_state` / `import_state` wrappers (compose core export/import with
  message-store fields; KEEP the legacy blob migrations: `legacy_message_t`
  path and `"read"` → `"processed"`)
- Hook wiring in the hidden block; 4 `::actor::` delegating shims
- `export_address_document` (trivial; can move to core if convenient)

**messenger.mu:**
- Chat store: `chat_msg_t`, `history`, `append_history`, `get_conversation`,
  `mark_read`, `get_profile`, `list_pending_invites`
- `export_state` / `import_state` wrappers (keep the agent-blob-import door:
  missing `$history` → empty)
- Hook wiring; `::actor::` shims for `accept_contact` + `receive_message` only
  (it never had the other two inbound trns — keep it that way)

Expected size: actor.mu 1338 → ~400 lines; messenger.mu 506 → ~200; core +~900.

## Implementation order

0. **Compile probe FIRST:** tiny throwaway library in core declaring a `trn`,
   mutable state, and using `_new_id`, `_get_container_id()`,
   `grab(_read_or_abort)`, `current_transaction_info`, `encrypted_channel`
   calls — compile a consumer packet with it and exercise the trn. The
   library-trn precedent is verified in stdlib, but not these primitives inside
   OUR library. If something fails here, fall back to library-of-bodies +
   one-line app `trn` shims for everything (same sharing, more shims).
   **✅ DONE (2026-06-12).** All primitives work from a core library, verified
   at runtime over the broker (encrypted ping routed to `::probe_lib::probe_ping`).
   Findings that constrain the later steps:
   - `grab()` is application-only ("Using grab outside an application is not
     allowed") → `$_read_or_abort` must be init-injected, as planned.
   - mufl function TYPES are single-argument (`(any -> T)`); multi-arg hooks
     take one record. Hook lambdas passed to init must be typed `arg: any`
     and destructure in the body — a record-typed lambda fails the meta-stage
     type check against an `(any -> ...)` parameter.
   - Non-hidden library state IS readable and assignable from the app
     (`lib::var -> value` works) — transition steps 2–4 can rely on it.
   - App closures injected as hooks can mutate app state and build
     `transaction::action` lists from library context.
   - App-level trns are addressed `::<application-name>::<trn>` by the host,
     library trns `::<library>::<trn>` — both coexist, same names no conflict.
1. `a2a_messaging.mm` (state + Tier 1 trns + hooks + message path), update
   core `config.mufl`, bump `version.mm` MIN, update core README.
   **✅ DONE (2026-06-12).** Core at MIN 1.1. Verified: actor.mu packet
   recompiles + full spike-multi E2E passes; a temp consumer loading
   a2a_messaging alongside actor's same-named app trns compiles, and at
   runtime `::a2a_messaging::get_version/set_my_name/generate_invite` work
   with library state isolated from app state. NOT yet wired into actor.mu
   (that is step 2): the library compiles into the unit but the host still
   addresses the `::actor::*` app trns.
2. Thin out `actor.mu`: wire hooks, keep message store + export/import +
   4 shims; update `plugin/src/index.ts` transaction-name strings.
   **✅ DONE (2026-06-12).** Core at MIN 1.2. actor.mu 1338 → ~860 lines
   (local-book + hierarchy trns still in it — they move in step 3). Notes:
   - Shim mechanics: core exports `handle_accept_contact` / `handle_receive_message`
     FNs (the stdlib trn-delegates-to-fn pattern, cf. `address_document::handshake_init`);
     both the core trns and the app `::actor::` shims call them.
   - Indexed assignment into library map state from the app works
     (`a2a_messaging::contacts key -> value`) — used throughout the remaining
     app trns until step 3 moves them into core.
   - `import_state` delegates core fields to `a2a_messaging::import_core_state`
     (which replays peer_ads), then does inbox migration + local-book fields +
     pending-introduction AD replay app-side.
   - Verified: compile; spike-multi E2E on the new unit; `spike-upgrade.mjs`
     phase1/phase2 — a PRE-migration `export_state` blob (old unit
     360F8BAF…) imports into the new unit (264E6E0F…) restoring contacts +
     inbox with working encrypted channels (no re-handshake), and cross-version
     messaging passes BOTH ways (old→new via the shims, new→old via the
     unchanged `::actor::` sender names).
   - Host renames (`::actor::` → `::a2a_messaging::`): set_my_name, set_my_bio,
     generate_invite, add_contact, send_message, remove_contact, list_contacts,
     list_contact_roots (in `plugin/src/index.ts` + `spike-multi.mjs`).
     `get_version` had no host caller; the app-level copy was dropped.
3. `a2a_hierarchy.mm` + `a2a_local_book.mm`; thin actor.mu further.
   **⏸ DEFERRED (2026-06-12).** These transactions are AGENT-ONLY — the
   messenger never duplicated them (it only verifies chains via the already-
   shared `a2a_protocol`), so moving them eliminates no duplication. They also
   need extra hook plumbing (sibling_introduce/local_introduce deposit into
   the agent inbox and the pending-introduction queue). Do this as a separate
   tidy-up when a second consumer actually wants hierarchy/local-book.
4. Thin out `messenger.mu` + its host the same way.
   **✅ DONE (2026-06-12).** messenger.mu 506 → ~270 lines. Hooks:
   `on_message_received` appends "in" history (aborts on unknown sender — the
   messenger has no pending-introduction queue), `on_message_sent` appends
   "out", `on_contact_removed` drops the conversation. Kept app-side:
   chat store + `get_profile`, `list_pending_invites` (reads
   `a2a_messaging::pending_invites`), `get_conversation`/`mark_read` (via
   `a2a_messaging::resolve_contact`), export/import wrappers (blob now also
   carries the core hierarchy fields; `$history`-missing agent-blob door
   kept), and the 2 `::actor::` shims. Host renames in `MessengerHost.ts`:
   set_my_name, generate_invite, add_contact, send_message, remove_contact,
   get_version, list_contacts, list_contact_roots → `::a2a_messaging::`.
   Verified: browser smoke (full contact+message round trip, SMOKE-OK on
   core 1.2) and `messenger/scripts/spike-upgrade-cross.mjs` —
   phase1/phase2: PRE-migration messenger `export_state` blob (old unit
   38D40A29…) imports into the new unit (3AD26C0A…) restoring contacts +
   per-contact history + profile with working channels (no re-handshake),
   and old⇄new messaging passes both ways; phase3: NEW agent ⇄ NEW messenger
   interop with invites in both directions and messages both ways.
5. Bump submodule pins in both apps (per memory: bump `core/version.mm` on
   every core change).
   **✅ DONE (2026-06-12).** Core committed + pushed as `ba5e367` (version
   1.2); both apps pinned to it.

## Verification (each step)

- Both packets compile (`scripts/compile-mufl.sh`).
- **Upgrade safety:** `import_state` of a PRE-migration `export_state` blob
  restores contacts/peers/inbox correctly (this is the real test).
- Cross-version interop: new agent ⇄ old messenger and vice versa —
  invite → add_contact → send_message both directions (Option A shims +
  unchanged sender-side `::actor::` names make this pass).
- Agent flows: identity create/bind, local-book connect, sibling connect,
  message lifecycle incl. gc + defer.

## DEFERRED (do NOT implement now — design notes for later phases)

Recorded so the protocol-layer extensibility isn't lost; all arrive later as
MIN-bump additive core revisions:

1. **Versioned message record on the wire** (prereq for everything below):
   new library-routed receive trn accepting tolerant `any` with
   `($v, $kind ["text"...], $mid -> sender-assigned global message id, $text)`;
   legacy `::actor::receive_message` stays frozen at bare-`$text` and adapts
   inbound into the record. Sender-assigned `$mid` is what makes cross-peer
   message references possible (today's msg_id is receiver-local).
   When this lands, widen the storage hooks to take the whole record.
2. **Per-contact version exchange:** carry `$core_version` in `accept_contact`
   and both introduces → `peer_versions` map → `require_peer_version` helper
   aborting with a graceful "incompatible version" error. Senders downgrade
   plain text for old peers, refuse non-downgradable features.
3. **Reply-to / threads:** `$reply_to -> mid` field only.
4. **Files / photos:** inline `attachment_t ($name,$mime,$size,$hash,$data)`
   for small payloads; chunked-transfer core module (offer/chunk/complete) for
   large. App-side egress (notify path carries no body today) is per-host work.
5. **Group chats:** `a2a_groups.mm`, fan-out over existing pairwise channels,
   `$group_id` on the message record, membership = owner-signed document (same
   pattern as the existing delegation certs). Shared group keys = later
   protocol revision.
6. Removal of the `::actor::` compat shims once no old clients remain.
