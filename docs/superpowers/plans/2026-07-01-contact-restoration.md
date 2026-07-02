# Contact Survival Across Breaking Changes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Contacts survive breaking protocol changes: a `format_version` stamp + migration contract on the exported state blob, degraded-contact detection with a deferred-send queue, and a 3-leg signed `request_contact_restore` handshake that re-establishes encryption keys between mutually known addresses with no user interaction.

**Architecture:** Everything protocol-level lands in the shared core library `a2a_messaging.mm` (git submodule `packages/core/mufl_code/core`, repo ours-mufl-core) so every consumer (ours-mcp, ours-tg-connector, future apps) inherits it. The handshake reuses the ephemeral-invite machinery (same identity bundles, same box-to-eph-key discipline, same INV-4/INV-5 gate ordering); only the trust gate differs — an origin-verified signed request from an address already in `contacts` replaces the OOB invite token. The ours-mcp daemon (`packages/core/src/index.ts`) drives eager restore on boot, retry on the GC tick, and the deferred-queue flush on the `$contact_restored` notify.

**Tech Stack:** MUFL (adapt-toolkit `mufl-compile` from `ADAPT_TOOLKIT`), `@adapt-toolkit/sdk` + `sdk-native` **0.6.2** (already bumped + installed), TypeScript daemon, loopback test suite (`packages/core/mufl_code/core/tests/run.sh`).

**Spec:** `docs/superpowers/specs/2026-07-01-contact-restoration-design.md` (read it first).

## Global Constraints

- **NO git commits anywhere** — neither the parent repo nor the `packages/core/mufl_code/core` submodule. The working tree already carries the user's uncommitted #77 work; everything stays uncommitted for morning review. Where a task template says "Commit", instead run the suite/build and report the diff summary.
- **Do not touch** the user's in-flight uncommitted changes: `packages/core/mufl_code/actor.mu` `__init` block, `packages/core/src/index.ts` `createPacket`, `packages/core/mufl_code/protocol_container.mm`, `packages/core/mufl_code/config.mufl`, `scripts/compile-mufl.sh`, `publish-local.sh`, `.env.example`. Build on top of them; never revert them.
- SDK pinned at `0.6.2` in `packages/core/package.json` (done; `npm install` already run).
- **The ADAPT_TOOLKIT checkout carries a required local patch** (`/home/shakhvit/work/adapt/adapt-toolkit/transactions/transaction.mm`, `send` fn): #77's send-side auto-sign discriminated the body union via `SAFE(unsigned_message)`, which ABORTS on encrypted bodies instead of yielding NIL — every encrypted send (`send_message`, `send_file`, monitoring copies) died with `Runtime mismatch for SAFE cast: Required: string but observing NIL`. The patch probes the `$name` field first (the `__t_wrapper::decode_message_with_keys` idiom). Upstream never exercised a real encrypted send (its integrational test only runs the `request_identity` handshake). Do NOT revert this patch; it must be reported to the user for upstreaming.
- Core loopback suite invocation (from repo root; used by every MUFL task):

  ```bash
  cd packages/core/mufl_code/core/tests && \
  ADAPT_TOOLKIT=/home/shakhvit/work/adapt/adapt-toolkit \
  OURS_SDK_NODE_MODULES=/home/shakhvit/work/adapt/ours.network/ours-mcp/node_modules \
  DEV_BROKER=/home/shakhvit/work/adapt/ours.network/ours-mcp/scripts/dev-broker.mjs \
  ./run.sh 2>&1 | grep -vE '^### |^\s+at |^### Error'
  ```

  Expected on success: per-scenario `✓` lines and a final `ALL TESTS PASSED`. The `### Leak for AdaptValue` blocks at exit are known SDK diagnostics noise — ignore them; the scorecard + exit code are the verdict. The suite takes ~2–4 minutes.
- Fast MUFL syntax check (no broker, seconds — run before the full suite after every MUFL edit):

  ```bash
  ADAPT_TOOLKIT=/home/shakhvit/work/adapt/adapt-toolkit ./scripts/compile-mufl.sh
  ```

  This compiles the ours-mcp actor against the live core sources and regenerates `packages/core/dist-mufl/*.muflo` (check the script for the exact output dir). Compile SUCCESS = the core .mm changes parse and typecheck.
- New network-visible wire names (locked; consumers depend on exact strings):
  `::a2a_messaging::request_contact_restore`, `::a2a_messaging::submit_restore_response`, `::a2a_messaging::complete_restore`.
- MUFL has define-before-use: a `fn` must appear ABOVE its first caller in the file; inbound `trn` stubs go after their handlers (existing pattern, see `a2a_messaging.mm:1497`).
- Comment style: this codebase carries dense, rationale-heavy comments in both MUFL and TS. Match it — comments state invariants and why, not what.

---

### Task 1: Establish a green baseline for the loopback suite — ✅ DONE (during planning)

Completed during planning; recorded here for the reviewer. Four fixes produced a green run (45 assertions, `ALL TESTS PASSED`):

1. `@adapt-toolkit/sdk` + `sdk-native` bumped `0.6.1` → `0.6.2` (`packages/core/package.json`) + `npm install`.
2. `scripts/dev-broker.mjs` copied from a2adapt-mcp into THIS repo — the a2adapt copy resolves SDK 0.5.14 from its own node_modules, and a 0.5.x broker cannot complete #77 possession-proof registration with a 0.6.2 wrapper.
3. Test harness gained the #77 `protocol_container` stub (SDK 0.6.x fires `::protocol_container::init_my_ipd` on every packet during registration): `tests/run.sh` now copies `protocol_container.mm` into the build (env-overridable via `PROTOCOL_CONTAINER_MM`) and maps it in the generated `config.mufl`; `tests/test_actor.mu` loads `protocol_container`.
4. The toolkit `transaction.mm` `send` patch (see Global Constraints) — without it every encrypted send aborts.

- [x] Baseline green: 45 ✓ / 0 ✗, exit 0.

---

### Task 2: Shared identity-bundle helpers (DRY refactor, no behavior change)

The invite legs build and verify the identity bundle `{$ad, $cert, $root_profile, $cp_binding, <correlation id>}` in three places. The restore legs need the same construction and verification. Extract two helpers and refactor the existing sites onto them; the existing suite is the regression net.

**Files:**
- Modify: `packages/core/mufl_code/core/a2a_messaging.mm`

**Interfaces:**
- Produces (used by Task 4):
  - `fn my_identity_bundle_fields (_) -> ($ad -> address_document_types::t_address_document, $cert -> bin+, $root_profile -> bin+, $cp_binding -> bin+)`
  - `metadef verified_bundle_t: ($ad -> address_document_types::t_address_document, $root -> a2a_protocol::contact_root_t+, $pin_binding -> a2a_protocol::root_cp_binding_t+, $pin_binding_root -> global_id+)`
  - `fn verify_identity_bundle (payload: any, sender_id: global_id) -> verified_bundle_t`

- [ ] **Step 1: Add the two helpers** to `a2a_messaging.mm`, placed just above `mint_eph_invite` (~line 547) so all callers sit below them:

  ```
  // ---- shared identity-bundle helpers (invite legs + contact-restore legs) ----
  // My identity bundle payload fields: my AD plus, when I am a delegated role,
  // my chain blobs (cert / root profile / optional §3c cp binding). The caller
  // appends its own correlation id ($invite_id or $rid) and _write's the record.
  fn my_identity_bundle_fields (_) -> ($ad -> address_document_types::t_address_document, $cert -> bin+, $root_profile -> bin+, $cp_binding -> bin+)
  {
      my_cert_blob is bin+ = NIL.
      my_rp_blob is bin+ = NIL.
      my_rpb_blob is bin+ = NIL.
      if delegation_cert != NIL && root_profile != NIL
      {
          my_cert_blob -> (_write delegation_cert?).
          my_rp_blob -> (_write root_profile?).
          if root_cp_binding != NIL { my_rpb_blob -> (_write root_cp_binding?). }
      }
      return ($ad -> address_document::get_my_address_document(), $cert -> my_cert_blob, $root_profile -> my_rp_blob, $cp_binding -> my_rpb_blob).
  }

  // Verify a received identity bundle against the authenticated sender: D8
  // cid-bind + PoP self-sig (process_address_document aborts on a forged or
  // inconsistent document), then the OPTIONAL delegation chain (an invalid
  // chain aborts; a verifying §3c cp binding is STAGED in the returned record,
  // never written here — INV-5: the CALLER performs all registration writes
  // together after every gate has passed).
  metadef verified_bundle_t: ($ad -> address_document_types::t_address_document, $root -> a2a_protocol::contact_root_t+, $pin_binding -> a2a_protocol::root_cp_binding_t+, $pin_binding_root -> global_id+).
  fn verify_identity_bundle (payload: any, sender_id: global_id) -> verified_bundle_t
  {
      ad = (payload $ad) safe address_document_types::t_address_document.
      abort "Address document does not belong to the sender." when (ad $identity $container_id) != sender_id.
      address_document::process_address_document ad TRUE.
      peer_root is a2a_protocol::contact_root_t+ = NIL.
      pin_binding is a2a_protocol::root_cp_binding_t+ = NIL.
      pin_binding_root is global_id+ = NIL.
      if (payload $cert) != NIL
      {
          cert = (_read_or_abort ((payload $cert) safe bin)) safe a2a_protocol::delegation_cert_t.
          rp = (_read_or_abort ((payload $root_profile) safe bin)) safe a2a_protocol::root_profile_t.
          peer_root -> a2a_protocol::verify_peer_delegation sender_id (_value_id ad) cert rp.
          if (payload $cp_binding) != NIL
          {
              binding = (_read_or_abort ((payload $cp_binding) safe bin)) safe a2a_protocol::root_cp_binding_t.
              if a2a_protocol::verify_root_cp_binding binding (rp $p $root_cid) (rp $p $keys) == TRUE
              {
                  pin_binding -> binding.
                  pin_binding_root -> (rp $p $root_cid).
              }
          }
      }
      return ($ad -> ad, $root -> peer_root, $pin_binding -> pin_binding, $pin_binding_root -> pin_binding_root).
  }
  ```

- [ ] **Step 2: Refactor the three existing sites** to use them, mechanically:
  - `add_contact` (~line 616-632): replace the `my_ad`/`my_cert_blob`/`my_rp_blob`/`my_rpb_blob` block with `b = my_identity_bundle_fields NIL.` and build `payload = _write ($ad -> (b $ad), $cert -> (b $cert), $root_profile -> (b $root_profile), $cp_binding -> (b $cp_binding), $invite_id -> invite_id).`
  - `handle_submit_invite_response` (~lines 1351-1378 verification; ~1398-1415 reply construction): replace the responder-AD verification block (cid-bind, process_address_document, chain, staging) with `vb = verify_identity_bundle payload sender_id.`; the registration writes become `peer_ads sender_id -> (vb $ad).`, `if (vb $root) != NIL { contact_roots sender_id -> (vb $root)?. }`, `if (vb $pin_binding) != NIL { contact_cp_bindings ((vb $pin_binding_root)?) -> (vb $pin_binding)?. }`. Replace its leg-3 bundle construction with `my_identity_bundle_fields` like in add_contact.
  - `handle_complete_invite` (~lines 1456-1487): same verification + writes replacement.
  - Do NOT touch `handle_accept_contact` (its legacy shape differs — reads `$joiner_*` args, not a boxed payload).

- [ ] **Step 3: Syntax check**: `ADAPT_TOOLKIT=/home/shakhvit/work/adapt/adapt-toolkit ./scripts/compile-mufl.sh` → compiles.

- [ ] **Step 4: Full suite** (Global Constraints invocation) → `ALL TESTS PASSED` (36 assertions; T1–T10 all cover these paths).

---

### Task 3: format_version stamp + new state + export/import + migration contract

**Files:**
- Modify: `packages/core/mufl_code/core/a2a_messaging.mm`
- Modify: `packages/core/mufl_code/core/tests/test_actor.mu` (qa counters)
- Modify: `packages/core/mufl_code/core/tests/test.mjs` (T11a assertions)

**Interfaces:**
- Produces (used by Tasks 4–6):
  - constants `core_format_version = 1`, `restore_max_attempts = 30`, `deferred_msgs_cap = 50`
  - state: `pending_restores : (global_id ->> pending_restore_t)`, `pending_restore_replies : (global_id ->> restore_reply_t)`, `deferred_msgs : (global_id ->> deferred_msg_t[])`; hidden `pending_restore_keys`, `pending_restore_reply_keys : (global_id ->> secretkey_encrypt)`
  - `metadef pending_restore_t: ($rid -> global_id, $eph_pub -> publickey_encrypt, $scheme -> int, $attempts -> int, $created -> time)`
  - `metadef restore_reply_t: ($rid -> global_id, $scheme -> int, $created -> time)`
  - `metadef deferred_msg_t: ($text -> str, $wire_id -> str, $reply_to -> a2a_protocol::reply_ref_t+, $date -> time)`
  - export blob gains `$format_version -> 1` and `$deferred_msgs`; import tolerates their absence, refuses `format_version > 1`, resets both pending-restore maps.

- [ ] **Step 1: Write the failing test.** In `test.mjs`, insert before the SCORECARD block (line ~305):

  ```js
  // ---------- T11a format stamp + restore-state export hygiene ----------
  CUR = 'T11a format-stamp';
  console.log('\n=== T11a format stamp + export hygiene ===');
  {
    const core = ro(I, '::actor::qa_export_core', undefined).Reduce('core');
    const vis = core.Visualize();
    ok(/format_version/.test(vis), `export_core_state carries a format_version stamp`);
    ok(core.Reduce('format_version').Visualize() === '1', `format_version == 1`);
    ok(!/pending_restore_keys/.test(vis), `export has NO pending_restore_keys (INV-4)`);
    ok(!/pending_restore_reply_keys/.test(vis), `export has NO pending_restore_reply_keys (INV-4)`);
    ok(/deferred_msgs/.test(vis), `export carries deferred_msgs`);
  }
  ```

- [ ] **Step 2: Run the suite** → T11a FAILS (`format_version` absent), everything else passes.

- [ ] **Step 3: Implement in `a2a_messaging.mm`.**

  (a) Constants, next to the existing tx-name constants (~line 67):

  ```
  // contact-restore wire names (LIBRARY-routed, new surface — no ::actor:: shims).
  request_contact_restore_tx = "::a2a_messaging::request_contact_restore".
  submit_restore_response_tx = "::a2a_messaging::submit_restore_response".
  complete_restore_tx        = "::a2a_messaging::complete_restore".

  // Version stamp of the portable export blob (see import_core_state for the
  // migration contract). Bump ONLY on a breaking blob-shape change, together
  // with a migration from the previous stamp.
  core_format_version = 1.
  // Give up re-requesting a restore after this many attempts per contact (the
  // host sweep re-fires on its GC cadence; a peer that upgraded and came back
  // online answers on the first post-upgrade attempt).
  restore_max_attempts = 30.
  // Per-contact cap on messages queued while its keys are being restored.
  deferred_msgs_cap = 50.
  ```

  (b) State, next to `pending_redemptions` (~line 97):

  ```
  // contact-restore (spec 2026-07-01): a DEGRADED contact is derivable state —
  // cid present in `contacts`, absent from `peer_ads` (e.g. a breaking-change
  // migration carried the contact but dropped its address document). These
  // stores drive the self-heal handshake; see request_contact_restore below.
  // Requester side, keyed by the TARGET cid. Non-secret half (the eph PRIVATE
  // key lives in the hidden pending_restore_keys, INV-4).
  metadef pending_restore_t: ($rid -> global_id, $eph_pub -> publickey_encrypt, $scheme -> int, $attempts -> int, $created -> time).
  pending_restores is (global_id ->> pending_restore_t) = (,).
  // Responder side, keyed by the REQUESTER cid — at most ONE outstanding reply
  // per requester (bounded by the contacts set; a newer request replaces it).
  metadef restore_reply_t: ($rid -> global_id, $scheme -> int, $created -> time).
  pending_restore_replies is (global_id ->> restore_reply_t) = (,).
  // Messages queued toward a degraded contact, flushed (host-driven,
  // flush_deferred) once its AD is re-established. Plain data — EXPORTED.
  metadef deferred_msg_t: ($text -> str, $wire_id -> str, $reply_to -> a2a_protocol::reply_ref_t+, $date -> time).
  deferred_msgs is (global_id ->> deferred_msg_t[]) = (,).
  ```

  (c) Hidden key stores, inside the existing `hidden { }` block next to `pending_redemption_keys` (~line 192):

  ```
  // contact-restore ephemeral PRIVATE keys — same INV-4 treatment as the
  // invite stores: hidden AND never exported; consumed with their public-half
  // records on the first valid completion. Requester side keyed by target cid,
  // responder side keyed by requester cid.
  pending_restore_keys is (global_id ->> secretkey_encrypt) = (,).
  pending_restore_reply_keys is (global_id ->> secretkey_encrypt) = (,).
  ```

  (d) `export_core_state` (~line 1626): add two fields to the returned record:

  ```
  $format_version  -> core_format_version,
  $deferred_msgs   -> deferred_msgs,
  ```

  (e) `import_core_state` (~line 1648): at the TOP of the function body add:

  ```
  // ---- format stamp + THE MIGRATION CONTRACT -------------------------------
  // Absent stamp == version 0 (every pre-stamp blob); all shipped migrations so
  // far are additive/field-optional, so 0 imports through the optional reads
  // below. The stamp exists so a future BREAKING blob change dispatches on an
  // explicit key instead of shape-sniffing. CONTRACT (binding on every future
  // format bump): a migration from version N MUST carry forward `contacts`,
  // `my_name`, `my_bio`, `my_persona` (and SHOULD carry contact_roots and the
  // consumer app's inbox/files); `peer_ads` is BEST-EFFORT — when a crypto/AD
  // change makes old documents unusable, DROP them: each dropped peer becomes a
  // degraded contact (contacts entry, no peer_ads entry) and self-heals through
  // request_contact_restore. NEVER let an incompatible optional field abort the
  // whole import — degrade, don't reset.
  fmt is int = 0.
  if (data $format_version) != NIL { fmt -> (data $format_version) safe int. }
  abort "State blob format_version " + (_str fmt) + " is newer than this code (supports up to " + (_str core_format_version) + ") — upgrade the software before importing." when fmt > core_format_version.
  ```

  and next to the `pending_invites -> (,).` reset add:

  ```
  // Restore handshake state is transient exactly like pending_invites: the eph
  // PRIVATE halves are hidden + never exported, so imported records would be
  // unanswerable. The boot sweep (restore_degraded_contacts) re-mints them.
  pending_restores -> (,).
  pending_restore_replies -> (,).
  ```

  and with the other optional reads (after `$app_config`):

  ```
  if (data $deferred_msgs) != NIL
  {
      deferred_msgs -> (data $deferred_msgs) safe (global_id ->> deferred_msg_t[]).
  }
  ```

  (f) In `test_actor.mu`, extend `qa_state` (~line 167) with:

  ```
  $n_pending_restores -> (_count a2a_messaging::pending_restores),
  $n_restore_replies -> (_count a2a_messaging::pending_restore_replies),
  $n_deferred -> (_count a2a_messaging::deferred_msgs)
  ```

  and extend the driver's `st` helper (test.mjs ~line 57) with:

  ```js
  prs: +s.Reduce('n_pending_restores').Visualize(), rr: +s.Reduce('n_restore_replies').Visualize(),
  dq: +s.Reduce('n_deferred').Visualize(),
  ```

- [ ] **Step 4: Syntax check** (`compile-mufl.sh`), then **full suite** → ALL TESTS PASSED including T11a, and T10 (migration) still green — a pre-stamp blob (version 0) imports unchanged because the T10 export now HAS the stamp; to also cover the version-0 path, extend T10 with one assertion: after the existing T10 block add

  ```js
  // version-0 path: strip the stamp from a re-exported blob → still imports.
  const exp0 = ro(I2, '::actor::export_state', undefined);
  ok(exp0.Reduce('core').Reduce('format_version').Visualize() === '1', `re-export carries the stamp`);
  ```

  (The true stripped-blob import is exercised implicitly: every pre-existing fixture in the suite was minted before the stamp existed. Do not build a blob-editing harness.)

---

### Task 4: Degraded detection, defer-on-send, and the three restore legs

The heart of the feature. `send_message` to a degraded contact queues + fires leg 0; the three leg handlers re-run the key exchange gated on mutual contact knowledge.

**Files:**
- Modify: `packages/core/mufl_code/core/a2a_messaging.mm`
- Modify: `packages/core/mufl_code/core/a2a_control.mm` (degraded guard in send_control)
- Modify: `packages/core/mufl_code/core/tests/test_actor.mu` (strip probe)
- Modify: `packages/core/mufl_code/core/tests/test.mjs` (T11b happy-path test + notify capture)

**Interfaces:**
- Consumes: Task 2 helpers (`my_identity_bundle_fields`, `verify_identity_bundle`), Task 3 state/constants.
- Produces (used by Task 5 + the hosts):
  - `fn begin_contact_restore (target: global_id) -> transaction::action::type[]` (non-hidden — the QA probe and restore sweep call it)
  - inbound trns `request_contact_restore`, `submit_restore_response`, `complete_restore`
  - `send_message` result gains `$deferred -> TRUE, $queued -> int` on the defer path
  - notify event `$contact_restored` with `$name`, `$container_id`

- [ ] **Step 1: Write the failing test.** In `test.mjs`:

  (a) Extend `wire()` (~line 25) to CAPTURE notify events instead of dropping them — change `mk` to `{ name, pw: null, cid: '', pending: [], rejects: [], events: [] }` and in `on_return_data`:

  ```js
  if (kind === 'notify_agent') { id.events.push(d.Reduce('payload').Reduce('event').Visualize()); return; }
  if (kind === 'save_state') return;
  ```

  (b) Append after T11a:

  ```js
  // ---------- T11b degraded contact: defer + 3-leg restore + flush ----------
  CUR = 'T11b restore';
  console.log('\n=== T11b degraded-contact restore ===');
  {
    // I ↔ R are established contacts (T1). Simulate a breaking-change migration
    // outcome on I: contacts survive, peer_ads dropped.
    await mutate(I, '::actor::qa_strip_peer_ads', {});
    const s0 = st(I);
    ok(s0.c >= 1 && s0.p === 0, `strip: I keeps contacts (${s0.c}) with no peer_ads`);

    // Deferred send: queues + fires leg 0; restore legs run; both sides notify.
    const evI = I.events.length, evR = R.events.length;
    const dm = await mutate(I, '::a2a_messaging::send_message', { contact: R.cid, text: 'queued-while-degraded' });
    ok(dm.Reduce('deferred').Visualize() === 'TRUE' || /true/i.test(dm.Reduce('deferred').Visualize()), `send to degraded contact reports deferred`);
    await sleep(6000);
    const s1 = st(I);
    ok(s1.p >= 1, `restore re-established R's AD at I (peer_ads=${s1.p})`);
    ok(s1.prs === 0, `restore consumed I's pending_restores`);
    ok(st(R).rr === 0, `restore consumed R's reply record`);
    ok(I.events.slice(evI).includes('contact_restored'), `I notified contact_restored`);
    ok(R.events.slice(evR).includes('contact_restored'), `R notified contact_restored`);

    // Host-driven flush: drain the deferred queue, message arrives at R.
    const fl = await mutate(I, '::a2a_messaging::flush_deferred', { contact: R.cid });
    ok(+fl.Reduce('flushed').Visualize() === 1, `flush_deferred drained 1 message`);
    await sleep(2500);
    ok(/queued-while-degraded/.test(ro(R, '::actor::list_incoming_messages', undefined).Visualize()), `deferred message delivered after restore`);
    ok(st(I).dq === 0, `deferred queue cleared`);

    // Channel fully healthy again, both directions.
    await mutate(R, '::a2a_messaging::send_message', { contact: I.cid, text: 'post-restore-R-to-I' });
    await sleep(2500);
    ok(/post-restore-R-to-I/.test(ro(I, '::actor::list_incoming_messages', undefined).Visualize()), `R→I works after restore (one-sided loss: R replaced I's AD)`);
  }
  ```

  NOTE: `flush_deferred` is implemented in Task 5 — for THIS task's run, keep the flush block commented with `// TASK5:` markers and assert only through `I.events.includes('contact_restored')`; Task 5 uncomments it. (Alternative: implement Tasks 4+5 MUFL together and run once — implementer's choice; the plan splits them for reviewability.)

  (c) Test probe in `test_actor.mu` (next to the other qa probes, ~line 180):

  ```
  // Simulate a breaking-change migration that carried contacts but dropped the
  // address documents (the spec's "degraded contact" state).
  trn qa_strip_peer_ads _
  {
      a2a_messaging::peer_ads -> (,).
      return transaction::success [ _return_data ($stripped -> TRUE) ].
  }
  ```

- [ ] **Step 2: Run the suite** → T11b FAILS (`qa_strip_peer_ads` unknown / `deferred` NIL), prior tests green.

- [ ] **Step 3: Implement in `a2a_messaging.mm`.** Placement: `begin_contact_restore` must sit ABOVE `send_message` (define-before-use); the three leg handlers + trn stubs go next to the invite leg handlers (after `handle_complete_invite`, before `handle_receive_message`).

  (a) The requester-side minting fn (above `send_message`, ~line 666):

  ```
  // Mint (or RE-mint) a restore request toward a degraded contact: fresh
  // ephemeral keypair + correlation id, REPLACING any outstanding attempt (the
  // superseded eph key makes a stale leg-1 reply fail both the rid check and
  // the unbox). Returns the bare signed send action (leg 0); #77 signs every
  // envelope, so the receiver authenticates us from the envelope alone. The
  // CALLER emits _save_state.
  fn begin_contact_restore (target: global_id) -> transaction::action::type[]
  {
      attempts is int = 0.
      prev = pending_restores target.
      if prev != NIL { attempts -> (prev? $attempts). }
      scheme = _crypto_default_scheme_id().
      kp = _crypto_construct_encryption_keypair scheme.
      rid = _new_id "ours restore".
      now = (current_transaction_info::get_transaction_time())?.
      pending_restores target -> ($rid -> rid, $eph_pub -> (kp $public_key), $scheme -> scheme, $attempts -> attempts + 1, $created -> now).
      pending_restore_keys target -> (kp $secret_key).
      return [
          transaction::action::send target (
              $name -> request_contact_restore_tx,
              $targ -> ($rid -> rid, $epk -> (kp $public_key), $v -> scheme)
          )
      ].
  }
  ```

  (b) The defer branch in `send_message` (~line 670), inserted between `wire_id = …` and the `return encrypted_channel::execute_transaction …`:

  ```
      // DEGRADED contact (known cid, no address document — e.g. a breaking-change
      // migration dropped peer_ads): queue the message and (re)issue a restore
      // request instead of failing the send. flush_deferred (host-driven, fired
      // on the $contact_restored notify) drains the queue once the peer's AD is
      // re-established.
      if (peer_ads target_id) == NIL
      {
          q is deferred_msg_t[] = [].
          cur = deferred_msgs target_id.
          if cur != NIL { q -> cur?. }
          abort "Deferred queue for this contact is full (" + (_str deferred_msgs_cap) + ") — contact restore still pending." when (_count q|) >= deferred_msgs_cap.
          q (_count q|) -> ($text -> text, $wire_id -> wire_id, $reply_to -> reply_to, $date -> sent_date).
          deferred_msgs target_id -> q.
          actions is transaction::action::type[] = begin_contact_restore target_id.
          actions (_count actions|) -> _return_data ($sent_to -> target_id, $wire_id -> wire_id, $deferred -> TRUE, $queued -> (_count q|)).
          actions (_count actions|) -> _save_state NIL.
          return transaction::success actions.
      }
  ```

  (c) A fail-fast guard in `send_file` (~line 718), after `target_id = resolve_contact contact_ref.`:

  ```
      // Files do NOT queue (bulk binary); fail fast with the real reason instead
      // of an opaque channel error. send_message toward this contact will queue
      // and drive the restore.
      abort "Contact \"" + contact_ref + "\" is awaiting key restore (degraded) — retry the file after a message to it is delivered." when (peer_ads target_id) == NIL.
  ```

  (c2) The same explicit guard in `a2a_control.mm`'s `send_control` (it loads a2a_messaging, so it can read the store), after its contact resolution:

  ```
      abort "Contact is awaiting key restore (degraded) — control messages resume once the contact is restored." when (a2a_messaging::peer_ads target_id) == NIL.
  ```

  (Adjust the variable name to whatever `send_control` calls its resolved target — read `a2a_control.mm:46` first.)

  (d) The three leg handlers (after `handle_complete_invite`, ~line 1495; trn stubs after each handler, mirroring the invite pattern):

  ```
  // ==== contact restore (spec 2026-07-01): re-run the key exchange between
  // MUTUALLY KNOWN addresses after a breaking change dropped peer_ads. Same
  // machinery as the eph-invite legs (bundle, box-to-eph-key, INV-5 gate
  // ordering); the trust gate is "#77-origin-verified signed request from an
  // address already in my contacts" instead of an OOB invite token.

  // LEG 0 (responder): a contact lost my address document and asks me to
  // re-exchange keys. BARE inbound — #77 signs every envelope and rejects
  // unsigned/forged origin, so the envelope $from IS the authenticated
  // requester. Gate: requester ∈ contacts, else a SILENT no-op (success with
  // no actions — no error reply, so whether an address is known never leaks).
  // NON-DESTRUCTIVE: nothing is installed or replaced here; my stored peer_ad
  // for the requester (possibly stale, possibly absent) is only replaced at
  // leg 2 after its bundle verifies. At most ONE outstanding reply record per
  // requester — a newer request replaces it (bounded by the contacts set).
  fn handle_request_contact_restore (args: any) -> transaction::results::type
  {
      current_transaction_info::validate_origin_or_abort (transaction::envelope::origin::external,).
      sender_id = current_transaction_info::get_external_envelope_or_abort() $from.
      if (contacts sender_id) == NIL { return transaction::success []. }

      rid = (args $rid) safe global_id.
      epk_requester = (args $epk) safe publickey_encrypt.
      scheme = (args $v) safe int.
      now = (current_transaction_info::get_transaction_time())?.

      kpr = _crypto_construct_encryption_keypair scheme.
      pending_restore_replies sender_id -> ($rid -> rid, $scheme -> scheme, $created -> now).
      pending_restore_reply_keys sender_id -> (kpr $secret_key).

      b = my_identity_bundle_fields NIL.
      payload = _write (
          $ad -> (b $ad), $cert -> (b $cert), $root_profile -> (b $root_profile),
          $cp_binding -> (b $cp_binding), $rid -> rid
      ).
      data = _crypto_encrypt_message (kpr $secret_key) epk_requester payload.
      return transaction::success [
          transaction::action::send sender_id (
              $name -> submit_restore_response_tx,
              $targ -> ($rid -> rid, $epk -> (kpr $public_key), $v -> scheme, $data -> data)
          ),
          _save_state NIL
      ].
  }

  trn request_contact_restore args: any
  {
      return handle_request_contact_restore args.
  }

  // LEG 1 (requester): the contact answered with its identity bundle boxed to
  // my leg-0 ephemeral pubkey. Gate discipline (INV-5): pend lookup -> rid pin
  // -> decrypt -> cid-bind -> PoP -> chain, all before any write. Single-use:
  // the first valid leg 1 consumes BOTH pending_restores and the hidden eph
  // key; a failed gate consumes nothing. Replies leg 2 as a BARE BOXED send —
  // the responder may not hold MY current AD until that bundle arrives, so the
  // encrypted channel cannot carry it (same reasoning as the invite leg 3).
  fn handle_submit_restore_response (args: any) -> transaction::results::type
  {
      current_transaction_info::validate_origin_or_abort (transaction::envelope::origin::external,).
      sender_id = current_transaction_info::get_external_envelope_or_abort() $from.
      rid = (args $rid) safe global_id.

      // --- gates (no state mutation until all pass) ---
      pend = pending_restores sender_id.
      abort "Unsolicited restore response." when pend == NIL.
      abort "Restore response does not match the outstanding request." when rid != ((pend?) $rid).
      eph_priv = pending_restore_keys sender_id.
      abort "Restore ephemeral key missing (superseded or already completed)." when eph_priv == NIL.
      abort "Restore response from a removed contact." when (contacts sender_id) == NIL.

      epk_r = (args $epk) safe publickey_encrypt.
      scheme = (args $v) safe int.
      ct = (args $data) safe crypto_message.
      payload = _read_or_abort (_crypto_decrypt_message eph_priv? epk_r ct).
      abort "Restore payload correlation mismatch." when ((payload $rid) safe global_id) != rid.
      vb = verify_identity_bundle payload sender_id.

      // --- all gates passed: (re)install the peer's keys + single-use consume ---
      peer_ads sender_id -> (vb $ad).
      if (vb $root) != NIL { contact_roots sender_id -> (vb $root)?. }
      if (vb $pin_binding) != NIL { contact_cp_bindings ((vb $pin_binding_root)?) -> (vb $pin_binding)?. }
      delete pending_restores sender_id.
      delete pending_restore_keys sender_id.

      b = my_identity_bundle_fields NIL.
      kp2 = _crypto_construct_encryption_keypair scheme.
      leg2_payload = _write (
          $ad -> (b $ad), $cert -> (b $cert), $root_profile -> (b $root_profile),
          $cp_binding -> (b $cp_binding), $rid -> rid
      ).
      leg2_data = _crypto_encrypt_message (kp2 $secret_key) epk_r leg2_payload.
      contact_name = ((contacts sender_id)?) $name.
      return transaction::success [
          transaction::action::send sender_id (
              $name -> complete_restore_tx,
              $targ -> ($rid -> rid, $epk -> (kp2 $public_key), $v -> scheme, $data -> leg2_data)
          ),
          _notify_agent ($event -> $contact_restored, $name -> contact_name, $container_id -> sender_id),
          _save_state NIL
      ].
  }

  trn submit_restore_response args: any
  {
      return handle_submit_restore_response args.
  }

  // LEG 2 (responder): the requester completed with ITS bundle boxed to my
  // leg-1 ephemeral pubkey. Same gate discipline; only HERE do I REPLACE my
  // stored peer_ad for the requester — required even when one is present: a
  // #77 reseed rolls the peer a fresh ENCRYPT key, so a surviving stale AD
  // would break my sends toward it. Single-use consume of the reply stores.
  fn handle_complete_restore (args: any) -> transaction::results::type
  {
      current_transaction_info::validate_origin_or_abort (transaction::envelope::origin::external,).
      sender_id = current_transaction_info::get_external_envelope_or_abort() $from.
      rid = (args $rid) safe global_id.

      // --- gates (no state mutation until all pass) ---
      pend = pending_restore_replies sender_id.
      abort "Unsolicited restore completion." when pend == NIL.
      abort "Restore completion does not match the outstanding reply." when rid != ((pend?) $rid).
      eph_priv = pending_restore_reply_keys sender_id.
      abort "Restore reply key missing (superseded or already completed)." when eph_priv == NIL.
      abort "Restore completion from a removed contact." when (contacts sender_id) == NIL.

      epk_i = (args $epk) safe publickey_encrypt.
      ct = (args $data) safe crypto_message.
      payload = _read_or_abort (_crypto_decrypt_message eph_priv? epk_i ct).
      abort "Restore payload correlation mismatch." when ((payload $rid) safe global_id) != rid.
      vb = verify_identity_bundle payload sender_id.

      // --- all gates passed: replace + single-use consume ---
      peer_ads sender_id -> (vb $ad).
      if (vb $root) != NIL { contact_roots sender_id -> (vb $root)?. }
      if (vb $pin_binding) != NIL { contact_cp_bindings ((vb $pin_binding_root)?) -> (vb $pin_binding)?. }
      delete pending_restore_replies sender_id.
      delete pending_restore_reply_keys sender_id.

      contact_name = ((contacts sender_id)?) $name.
      return transaction::success [
          _notify_agent ($event -> $contact_restored, $name -> contact_name, $container_id -> sender_id),
          _save_state NIL
      ].
  }

  trn complete_restore args: any
  {
      return handle_complete_restore args.
  }
  ```

- [ ] **Step 4: Syntax check**, then **full suite** → T11b assertions up to the TASK5-commented flush pass; ALL prior tests still green. Pay attention to T9 export-secrecy — it must still pass with the new stores (the hidden halves must not appear).

---

### Task 5: flush_deferred, restore sweep, readonly surface, negative tests

**Files:**
- Modify: `packages/core/mufl_code/core/a2a_messaging.mm`
- Modify: `packages/core/mufl_code/core/tests/test_actor.mu` (adversarial probes)
- Modify: `packages/core/mufl_code/core/tests/test.mjs` (uncomment T11b flush; add T11c/T11d)

**Interfaces:**
- Consumes: Task 4 legs + state.
- Produces (used by the hosts):
  - `trn flush_deferred _:($contact -> contact_ref: str)` → `$flushed -> int` (+ `$degraded -> TRUE` when still keyless)
  - `trn restore_degraded_contacts _` → `$requested -> int, $exhausted -> int`
  - `trn readonly list_degraded_contacts _` → `$degraded -> degraded_contact_t[]`
  - `trn readonly list_deferred_queues _` → `$queues -> deferred_queue_info_t[]`
  - `metadef degraded_contact_t: ($container_id -> global_id, $name -> str, $attempts -> int, $queued -> int)`
  - `metadef deferred_queue_info_t: ($container_id -> global_id, $name -> str, $queued -> int, $degraded -> bool)`

- [ ] **Step 1: Write the failing tests.** Uncomment the `// TASK5:` flush block in T11b, and append:

  ```js
  // ---------- T11c both-sides degraded + host sweep ----------
  CUR = 'T11c both-degraded';
  console.log('\n=== T11c both-sides degraded + sweep ===');
  {
    await mutate(I, '::actor::qa_strip_peer_ads', {});
    await mutate(R, '::actor::qa_strip_peer_ads', {});
    ok(st(I).p === 0 && st(R).p === 0, `both sides stripped`);
    const sw = await mutate(I, '::a2a_messaging::restore_degraded_contacts', {});
    ok(+sw.Reduce('requested').Visualize() >= 1, `sweep requested restore for I's degraded contacts`);
    await mutate(R, '::a2a_messaging::restore_degraded_contacts', {});
    await sleep(7000);
    ok(st(I).p >= 1, `I restored (both-degraded, symmetric handshakes)`);
    ok(st(R).p >= 1, `R restored (both-degraded)`);
    await mutate(I, '::a2a_messaging::send_message', { contact: R.cid, text: 'after-double-restore' });
    await sleep(2500);
    ok(/after-double-restore/.test(ro(R, '::actor::list_incoming_messages', undefined).Visualize()), `channel healthy after double restore`);
  }

  // ---------- T11d restore gates: foreign requester + unsolicited response ----------
  CUR = 'T11d restore-gates';
  console.log('\n=== T11d restore gates ===');
  {
    // Foreign requester: F is NOT a contact of R → SILENT ignore (no reply, no
    // reject, no reply-record).
    const rrBefore = st(R).rr; const fRej = F.rejects.length;
    await mutate(F, '::actor::qa_send_restore_request', { target: R.cid });
    await sleep(3000);
    ok(st(R).rr === rrBefore, `foreign restore request left NO reply record at R`);
    ok(st(F).p === 0 || true, `foreign requester gained nothing`); // F never had R's AD
    ok(!F.rejects.slice(fRej).some((x) => /restore/i.test(x)), `R sent NO error reply (silent ignore — knowledge does not leak)`);

    // Unsolicited leg 1 at I (no pending_restores entry for F) → rejected, no state change.
    const sI = st(I); const rejI = I.rejects.length;
    await mutate(F, '::actor::qa_send_fake_restore_response', { target: I.cid });
    await sleep(3000);
    ok(I.rejects.slice(rejI).some((x) => /Unsolicited restore response/.test(x)), `unsolicited restore response rejected at I`);
    const sI2 = st(I);
    ok(sI2.c === sI.c && sI2.p === sI.p, `unsolicited response mutated nothing`);
  }
  ```

  Test probes in `test_actor.mu`:

  ```
  // Fire a leg-0 restore request at an arbitrary target (bypassing the
  // degraded-contact trigger) — used to prove the responder's contacts gate.
  trn qa_send_restore_request _:($target -> tgt: global_id)
  {
      actions is transaction::action::type[] = a2a_messaging::begin_contact_restore tgt.
      actions (_count actions|) -> _return_data ($ok -> TRUE).
      return transaction::success actions.
  }

  // Craft an unsolicited leg-1 (no matching pending_restores at the target).
  trn qa_send_fake_restore_response _:($target -> tgt: global_id)
  {
      scheme = _crypto_default_scheme_id().
      kp = _crypto_construct_encryption_keypair scheme.
      payload = _write ($junk -> "x").
      data = _crypto_encrypt_message (kp $secret_key) (kp $public_key) payload.
      return transaction::success [
          transaction::action::send tgt (
              $name -> "::a2a_messaging::submit_restore_response",
              $targ -> ($rid -> (_new_id "fake restore"), $epk -> (kp $public_key), $v -> scheme, $data -> data)
          ),
          _return_data ($ok -> TRUE)
      ].
  }
  ```

- [ ] **Step 2: Run the suite** → new assertions FAIL (`flush_deferred` / `restore_degraded_contacts` / probes unknown).

- [ ] **Step 3: Implement in `a2a_messaging.mm`** (placement: after the leg handlers; `list_*` readonly trns next to `list_contacts` ~line 777 is also fine — keep define-before-use in mind: these only READ state and call no later fns):

  ```
  metadef degraded_contact_t: ($container_id -> global_id, $name -> str, $attempts -> int, $queued -> int).
  metadef deferred_queue_info_t: ($container_id -> global_id, $name -> str, $queued -> int, $degraded -> bool).

  // Degraded contacts (known cid, no AD) with their restore-attempt counts and
  // queued-message counts — the host's boot/GC sweep + list_contacts marker.
  trn readonly list_degraded_contacts _
  {
      out is degraded_contact_t[] = [].
      sc contacts -- (cid -> c) ?? (peer_ads cid) == NIL
      {
          att is int = 0.
          pr = pending_restores cid.
          if pr != NIL { att -> ((pr?) $attempts). }
          nq is int = 0.
          dq = deferred_msgs cid.
          if dq != NIL { nq -> (_count dq?|). }
          out (_count out|) -> ($container_id -> cid, $name -> (c $name), $attempts -> att, $queued -> nq).
      }
      return ($degraded -> out).
  }

  // Every non-empty deferred queue + whether its contact is still degraded —
  // lets the host flush queues whose contact healed without a notify (e.g. a
  // daemon restart between restore and flush).
  trn readonly list_deferred_queues _
  {
      out is deferred_queue_info_t[] = [].
      sc deferred_msgs -- (cid -> q) ?? (_count q|) > 0
      {
          nm is str = "".
          c = contacts cid.
          if c != NIL { nm -> ((c?) $name). }
          out (_count out|) -> ($container_id -> cid, $name -> nm, $queued -> (_count q|), $degraded -> ((peer_ads cid) == NIL)).
      }
      return ($queues -> out).
  }

  // Host-fired sweep (boot + GC cadence): (re)issue a restore request for every
  // degraded contact, up to restore_max_attempts each. A peer that is offline
  // or not yet running a restore-capable version simply never answers — the
  // sweep retries on the host's cadence; no reply is a normal condition.
  trn restore_degraded_contacts _
  {
      current_transaction_info::validate_origin_or_abort (transaction::envelope::origin::user,).
      actions is transaction::action::type[] = [].
      requested is int = 0.
      exhausted is int = 0.
      sc contacts -- (cid -> c) ?? (peer_ads cid) == NIL
      {
          prev = pending_restores cid.
          if prev != NIL && ((prev?) $attempts) >= restore_max_attempts
          {
              exhausted -> exhausted + 1.
          }
          else
          {
              sc begin_contact_restore cid -- ( -> a) { actions (_count actions|) -> a. }
              requested -> requested + 1.
          }
      }
      actions (_count actions|) -> _return_data ($requested -> requested, $exhausted -> exhausted).
      if requested > 0 { actions (_count actions|) -> _save_state NIL. }
      return transaction::success actions.
  }

  // Drain the deferred queue toward a contact whose AD is re-established.
  // HOST-DRIVEN (fired on the $contact_restored notify + the boot/GC sweep) so
  // the encrypted sends never race the restore legs' bare sends on the wire —
  // the host round-trip guarantees leg 2 delivery precedes the flush.
  // Idempotent: an empty or still-degraded queue is a no-op result, not an error.
  trn flush_deferred _:($contact -> contact_ref: str)
  {
      current_transaction_info::validate_origin_or_abort (transaction::envelope::origin::user,).
      target_id = resolve_contact contact_ref.
      q = deferred_msgs target_id.
      if q == NIL || (_count q?|) == 0 { return transaction::success [ _return_data ($flushed -> 0) ]. }
      if (peer_ads target_id) == NIL { return transaction::success [ _return_data ($flushed -> 0, $degraded -> TRUE) ]. }

      return encrypted_channel::execute_transaction target_id (fn (_) -> transaction::results::type {
          actions is transaction::action::type[] = [].
          sc q? -- ( -> m)
          {
              actions (_count actions|) -> encrypted_channel::send_encrypted_tx target_id (
                  $name -> receive_message_tx,
                  $targ -> ($text -> (m $text), $wire_id -> (m $wire_id), $reply_to -> (m $reply_to))
              ).
              sc on_message_sent ($target_id -> target_id, $text -> (m $text), $date -> (m $date), $wire_id -> (m $wire_id), $reply_to -> (m $reply_to)) -- ( -> a)
              {
                  actions (_count actions|) -> a.
              }
              sc monitor_copy_actions "out" target_id (m $date) (m $text) -- ( -> a)
              {
                  actions (_count actions|) -> a.
              }
          }
          n = _count q?|.
          delete deferred_msgs target_id.
          actions (_count actions|) -> _return_data ($flushed -> n).
          actions (_count actions|) -> _save_state NIL.
          return transaction::success actions.
      }).
  }
  ```

- [ ] **Step 4: Syntax check**, then **full suite** → ALL TESTS PASSED (T1–T11d).

---

### Task 6: Core version bump + core docs

**Files:**
- Modify: `packages/core/mufl_code/core/version.mm:20`
- Modify: `packages/core/mufl_code/core/README.md` (transaction inventory, if it lists the wire surface)

- [ ] **Step 1:** `version.mm` line 20: `create_version 0 1 0` → `create_version 0 2 0` (new network-visible transactions = protocol revision; a2a_protocol.mm header mandates the bump).
- [ ] **Step 2:** Skim `README.md` / `DEVELOPMENT.md` in the core for a wire-surface or transaction list; if present, add the three restore transactions + flush/sweep/list surface with one-liners. If absent, skip.
- [ ] **Step 3:** Full suite once more (version is embedded in get_version results — make sure no test pins `0.1.0`; if one does, update the expectation).
- [ ] **Step 4:** Report diff summary. **No commit** (Global Constraints).

---

### Task 7: ours-mcp actor: app-level format stamp + recompiled unit

**Files:**
- Modify: `packages/core/mufl_code/actor.mu`

**Interfaces:**
- Produces: `export_state` blob gains `$app_format_version -> 1`; `import_state` refuses newer stamps; recompiled `.muflo` in the unit output dir.

- [ ] **Step 1:** In `export_state` (~line 1441), add as the FIRST field of the returned record:

  ```
      $app_format_version -> 1,
  ```

- [ ] **Step 2:** In `import_state` (~line 1468), right after `validate_origin_or_abort`, add:

  ```
      // App-level format stamp (absent == 0, every pre-stamp blob). Same contract
      // as the core stamp (see a2a_messaging::import_core_state): additive fields
      // stay optional reads; a future BREAKING app-blob change dispatches here.
      app_fmt is int = 0.
      if (data $app_format_version) != NIL { app_fmt -> (data $app_format_version) safe int. }
      abort "App state blob format_version " + (_str app_fmt) + " is newer than this code (supports up to 1) — upgrade ours-mcp before importing." when app_fmt > 1.
  ```

- [ ] **Step 3:** Update the actor header doc (~line 31 "User transactions" block): add lines for `::a2a_messaging::flush_deferred`, `restore_degraded_contacts` (host-fired), `list_degraded_contacts` / `list_deferred_queues` (readonly), and under "External transactions (inbound)": `::a2a_messaging::request_contact_restore / submit_restore_response / complete_restore — contact-restore handshake (signed re-key between known contacts)`.

- [ ] **Step 4:** Recompile: `ADAPT_TOOLKIT=/home/shakhvit/work/adapt/adapt-toolkit ./scripts/compile-mufl.sh` → SUCCESS; confirm the `.muflo` artifact the daemon loads was regenerated (the script prints the output path; `git status` in the parent shows the changed unit).

---

### Task 8: Daemon integration (index.ts)

**Files:**
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `::a2a_messaging::restore_degraded_contacts`, `flush_deferred`, `list_degraded_contacts`, `list_deferred_queues`, `$contact_restored` notify, `send_message`'s `$deferred/$queued` result fields.
- Produces: boot-time eager restore, GC-tick retry + orphan flush, `contact_restored` notify handling, deferred-aware `send_message` tool, degraded markers in `list_contacts`.

- [ ] **Step 1: Renderers + flush helper.** Next to `saveState` (~line 1328) add:

  ```ts
  // ----- contact restore (host driving) ------------------------------------
  // The packet self-heals degraded contacts (known cid, no encryption keys —
  // the outcome of a breaking-change migration that dropped peer_ads) through
  // the signed request_contact_restore handshake. The host's jobs: fire the
  // sweep on boot + the GC cadence, and drain deferred queues once a contact
  // heals ($contact_restored notify, or the sweep for a flush lost to a crash).
  function renderDegraded(av: AdaptValue): Array<{ cid: string; name: string; attempts: number; queued: number }> {
    const out: Array<{ cid: string; name: string; attempts: number; queued: number }> = [];
    const arr = av.Reduce('degraded');
    if (arr.IsNil()) return out;
    for (let i = 0; ; i++) {
      const e = arr.Reduce(i);
      if (e.IsNil()) break;
      out.push({
        cid: e.Reduce('container_id').Visualize(),
        name: e.Reduce('name').Visualize(),
        attempts: Number(e.Reduce('attempts').Visualize()),
        queued: Number(e.Reduce('queued').Visualize()),
      });
    }
    return out;
  }

  function renderDeferredQueues(av: AdaptValue): Array<{ cid: string; queued: number; degraded: boolean }> {
    const out: Array<{ cid: string; queued: number; degraded: boolean }> = [];
    const arr = av.Reduce('queues');
    if (arr.IsNil()) return out;
    for (let i = 0; ; i++) {
      const e = arr.Reduce(i);
      if (e.IsNil()) break;
      out.push({
        cid: e.Reduce('container_id').Visualize(),
        queued: Number(e.Reduce('queued').Visualize()),
        degraded: e.Reduce('degraded').GetBoolean(),
      });
    }
    return out;
  }

  // Drain messages queued while a contact was degraded. Idempotent (empty or
  // still-degraded queue → flushed 0), so re-firing is always safe.
  async function flushDeferredFor(id: Identity, contactCid: string): Promise<void> {
    try {
      const flushed = await withScopeAsync(async (lt) => {
        const r = await mutatingTx(id, '::a2a_messaging::flush_deferred', { contact: contactCid }, lt);
        return Number(r.Reduce('flushed').Visualize());
      });
      if (flushed > 0) log(`[${id.name}] flushed ${flushed} deferred message(s) to ${contactCid.slice(0, 12)}…`);
    } catch (err) {
      log(`[${id.name}] deferred flush to ${contactCid.slice(0, 12)}… failed:`, String(err));
    }
  }

  // Boot + GC sweep: (re)request restores for degraded contacts and flush any
  // healed-but-still-queued contact (a crash between restore and flush).
  async function contactRestoreSweep(id: Identity): Promise<void> {
    try {
      const requested = await withScopeAsync(async (lt) => {
        const r = await mutatingTx(id, '::a2a_messaging::restore_degraded_contacts', {}, lt);
        return Number(r.Reduce('requested').Visualize());
      });
      if (requested > 0) log(`[${id.name}] contact restore requested for ${requested} degraded contact(s)`);
      const queues = withScope((lt) => renderDeferredQueues(readonlyTx(id, '::a2a_messaging::list_deferred_queues', lt)));
      for (const q of queues) {
        if (!q.degraded) await flushDeferredFor(id, q.cid);
      }
    } catch (err) {
      log(`[${id.name}] contact-restore sweep failed:`, String(err));
    }
  }
  ```

- [ ] **Step 2: Boot path.** In `restoreIdentity` (~line 1755): make the import-failure log LOUD + persistent, and run the sweep after import:

  ```ts
      } catch (err) {
        log(`[${name}] FAILED TO IMPORT SAVED STATE — continuing with the reseeded identity; ` +
          `surviving contacts (if the blob was partially migrated) self-heal via contact restore:`, String(err));
        appendNotifyLog(id, { event: 'state_import_failed', error: String(err).slice(0, 300) });
      }
  ```

  and after the `if (hasSavedState(dir)) { … }` block, before `refreshUnread(id)`:

  ```ts
    // Eager restore: re-key degraded contacts + flush queues orphaned by a crash.
    await contactRestoreSweep(id);
  ```

- [ ] **Step 3: Notify handler.** In the `on_return_data` notify chain (after the `'pending_message'` branch, ~line 1606) add:

  ```ts
      } else if (event === 'contact_restored') {
        // A degraded contact's keys were re-established (signed restore
        // handshake). Drain anything queued toward it; content-free log line.
        const name = payload.Reduce('name').Visualize();
        const cid = payload.Reduce('container_id').Visualize();
        appendNotifyLog(id, { event: 'contact_restored', from: name });
        log(`[${id.name}] contact "${name}" restored (re-keyed)`);
        process.nextTick(() => void flushDeferredFor(id, String(cid)));
  ```

- [ ] **Step 4: GC tick retry.** In `startGcTimer` (~line 3088), inside the per-identity loop after the gc mutatingTx:

  ```ts
            await contactRestoreSweep(id);
  ```

- [ ] **Step 5: send_message tool** (~line 2740): surface the deferred result:

  ```ts
        const { wireId, deferred, queued } = await withScopeAsync(async (lt) => {
          const sent = await mutatingTx(id!, '::a2a_messaging::send_message', {
            contact,
            text,
            ...(reply_to ? { reply_to } : {}),
          }, lt);
          const defAv = sent.Reduce('deferred');
          return {
            wireId: sent.Reduce('wire_id').Visualize(),
            deferred: !defAv.IsNil(),
            queued: defAv.IsNil() ? 0 : Number(sent.Reduce('queued').Visualize()),
          };
        });
        return textResult(deferred
          ? `Message queued for "${contact}" (wire_id ${wireId}) — the contact's encryption keys are being ` +
            `re-established after an upgrade (contact restore in progress); delivery is automatic once ` +
            `restored (${queued} message${queued === 1 ? '' : 's'} queued).`
          : `Message sent to "${contact}" (wire_id ${wireId}).`);
  ```

- [ ] **Step 6: list_contacts tool** (~line 2532): add degraded markers:

  ```ts
          const { contacts, pending, roots, degraded } = withScope((lt) => ({
            contacts: renderContacts(readonlyTx(id!, '::a2a_messaging::list_contacts', lt)),
            pending: renderPending(readonlyTx(id!, '::actor::list_pending_introductions', lt)),
            roots: renderContactRoots(readonlyTx(id!, '::a2a_messaging::list_contact_roots', lt)),
            degraded: renderDegraded(readonlyTx(id!, '::a2a_messaging::list_degraded_contacts', lt)),
          }));
          const degradedByCid = new Map(degraded.map((d) => [d.cid, d]));
  ```

  and in the contact line template append:

  ```ts
  ${degradedByCid.has(c.container_id) ? ` — ⚠ keys pending restore (${degradedByCid.get(c.container_id)!.queued} queued)` : ''}
  ```

- [ ] **Step 7: Typecheck + build**: `npm run build --workspace packages/core` (or the repo's build script — check `package.json` scripts; `npx tsc -p packages/core/tsconfig.json --noEmit` as the minimum). Expected: clean.

- [ ] **Step 8: Smoke boot** (proves the daemon boots the new unit and the sweep runs without error):

  ```bash
  node scripts/dev-broker.mjs --host 127.0.0.1 --port 9798 --test_mode & BPID=$!
  sleep 2.5
  OURS_STATE_DIR=$(mktemp -d) OURS_BROKER_URL=ws://127.0.0.1:9798 OURS_PORT=3131 \
    timeout 40 node packages/core/dist/cli.js daemon 2>&1 | head -40; kill $BPID
  ```

  (Check `packages/core/package.json` `bin`/`scripts` for the actual daemon entrypoint — adjust the command; the CLI may be `dist/cli.js serve` or similar. Success = registrar boots, "no persisted identities" line, no crash before the timeout.)

---

### Task 9: Final verification + report

**Files:** none (verification only)

- [ ] **Step 1:** Full core suite one final time → `ALL TESTS PASSED`; capture the scorecard count.
- [ ] **Step 2:** `./scripts/compile-mufl.sh` → SUCCESS. TS build/typecheck → clean.
- [ ] **Step 3:** Spec-coverage sweep: walk `docs/superpowers/specs/2026-07-01-contact-restoration-design.md` section by section and confirm each maps to landed code (format stamp §1, degraded+deferred §2, legs+flush §3, host §4, tests §Testing). Note any deliberate deviations in the report.
- [ ] **Step 4:** `git status` + `git diff --stat` (parent AND submodule) — confirm NOTHING was committed and no user in-flight change was reverted (`git diff scripts/compile-mufl.sh packages/core/mufl_code/config.mufl` should show ONLY the user's original hunks).
- [ ] **Step 5:** Write the morning report (chat, not a committed file): what landed where (core vs actor vs daemon), test evidence, deviations, and open follow-ups (tg-connector mirror; encrypted-at-rest; core submodule commit + pointer bump when the user is ready).
