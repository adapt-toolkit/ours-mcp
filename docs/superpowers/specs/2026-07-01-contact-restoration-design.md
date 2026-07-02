# Spec: Contact survival across breaking changes (format versioning + restore handshake)

**Date:** 2026-07-01
**Status:** Approved design
**Scope:** `ours-mufl-core` (protocol level, primary) → `ours-mcp` + `ours-tg-connector` (host integration)
**Depends on:** adapt-toolkit #77 (persistent address via SIGN-secret reseed; verifiable message origin) — see `2026-07-01-persistent-address-upgrade-design.md`

## Problem

After the #77 work, the survivor set across a breaking protocol change is:
`identity.key` (root SIGN secret → same container address), `registrar.key`, and
`book.json` (same-host public ADs). Everything relational lives only in
`state_data.bin`: `contacts`, `peer_ads` (per-contact address documents =
encryption/routing keys), bio, persona, messages. When `import_state` fails,
`restoreIdentity` logs and **continues fresh** (`packages/core/src/index.ts:1766`) —
silent, total contact loss. A future breaking change (state format or crypto/AD
format) therefore destroys every external contact even though both parties keep
their addresses.

## Goal

Make identities and their contacts survive breaking changes with no user-visible
disruption, at the **protocol level** so every application (ours-mcp,
ours-tg-connector, future apps) inherits it:

1. `state_data.bin` remains the single carrier of user state; breaking releases
   ship explicit migrations keyed on a format version stamp.
2. Migrations guarantee the survival of plain data (contacts, name, bio, persona,
   inbox); encryption keys are best-effort.
3. Contacts whose keys could not survive (**degraded contacts**) self-heal via a
   signed `request_contact_restore` handshake that re-runs the key exchange
   between mutually known addresses, silently.

## Design

### 1. Format versioning + migration contract

- `export_core_state` (`core/a2a_messaging.mm:1626`) and the actor-level
  `export_state` (`actor.mu:1431`) each gain an explicit integer
  `format_version` field, starting at 1.
- `import_core_state` / `import_state` dispatch on the stamp. The existing
  shape-sniffing shims (`actor.mu:1466-1560`, `a2a_messaging.mm:1648-1735`)
  remain only for pre-stamp blobs (treated as version 0).
- **Migration contract** (documented in the core, binding on future releases):
  - Every breaking release ships a migration from the previous format version.
  - The migration MUST preserve: `contacts` (cid → name; frozen shape),
    `my_name`, `my_bio`, `my_persona`, `contact_roots` where representable, and
    the app's `inbox` / `files` metadata.
  - `peer_ads` is BEST-EFFORT: if the crypto or address-document format changed,
    the migration drops them, producing degraded contacts that self-heal via the
    handshake (§3).
- Host behavior change: `restoreIdentity` import failure stops being silent.
  Migration is attempted first; only truly unreadable state falls through to
  fresh, with a loud log line.

### 2. Degraded contacts + deferred sends (core)

A **degraded contact** is derivable, not a stored flag: cid present in
`contacts` (`a2a_messaging.mm:84`) and absent from `peer_ads`
(`a2a_messaging.mm:103`). Two additions to core state:

- `pending_restores` (cid → `{eph_secret, restore_id, nonce, attempts, created}`)
  — outstanding restore requests. Like `pending_invites`
  (`a2a_messaging.mm:1656-1666`), reset to empty on import; boot re-fires them.
- `deferred_msgs` (cid → capped FIFO queue) — `send_message`
  (`a2a_messaging.mm:670`) targeting a degraded contact queues here instead of
  aborting, and triggers a restore request. The queue is flushed in order once
  the contact's `peer_ad` is re-established (host-driven, see §4). A full queue
  aborts the send with an explicit "restore still pending" error.
  `send_file` and `send_control` do NOT queue: files are bulk binary, and
  `a2a_control` sits ABOVE `a2a_messaging` in the library layering so the
  messaging core cannot emit control sends. Both fail fast with an explicit
  "contact is awaiting key restore" error instead of an opaque channel failure.

New readonly surface: `list_degraded_contacts` (cids + names) and pending/deferred
counts, for host boot logic and contact listings.

### 3. Restore handshake (core; reuses eph-invite machinery)

Implementation shape: a **new entry point into the existing invite-leg
machinery** (`a2a_messaging.mm:1499` `submit_invite_response`,
`:1504` `complete_invite`), not a parallel protocol. Bundles
(`{ad, cert, root_profile, cp_binding}`), boxing to ephemeral keys, and bundle
verification are identical; only the trust gate differs — OOB invite token is
replaced by "#77-origin-verified signed request from an address already in my
contacts".

- **Leg 0 — `request_contact_restore`** (new transaction; bare signed send
  A → B): payload `{rid, eph_pubkey, scheme}` — `rid` is a fresh global_id that
  serves as both correlation id and nonce (a separate nonce/timestamp adds
  nothing: nothing destructive happens before leg 2, and the single-use pending
  stores already kill replays). adapt #77 origin verification
  (`from == address_of_key(sign_pub)`, unsigned enveloped inbound rejected)
  proves A owns the root key behind its address — no extra crypto. B's
  acceptance gate: `from ∈ contacts`; otherwise **silent ignore** (success with
  no actions — no error reply, so whether the address is known never leaks).
  Leg 0 performs **no destructive change** on B; B keeps at most ONE
  outstanding reply record per requester (bounded by the contacts set).
- **Leg 1 — B → A**: B boxes its identity bundle plus `rid` to A's eph pubkey,
  and includes B's own fresh eph pubkey. A accepts only if a live
  `pending_restores` entry for B exists, `rid` matches, and the box opens with
  the kept eph secret. A installs B's verified AD and replies leg 2.
- **Leg 2 — A → B**: A boxes its bundle to B's eph pubkey (bare boxed send —
  B may not hold A's current AD until this very bundle arrives, so it cannot
  ride the encrypted channel). Only here does B (bundle verified as in the
  invite flow) **replace** its stored `peer_ad` for A. Both sides install
  fresh ADs and emit a `$contact_restored` notify; the encrypted channel
  resumes.
- **Flush is host-driven:** on the `$contact_restored` notify the daemon calls
  a `flush_deferred` transaction that drains the queue over the (now healthy)
  encrypted channel. Host-driven rather than in-transaction so the encrypted
  flush never races the bare restore legs on the wire; the host round-trip
  guarantees leg 2 delivery precedes the flush. `flush_deferred` is idempotent
  (empty or still-degraded queue → no-op), and boot/GC sweeps re-fire it for
  healed contacts whose flush was lost to a crash.

Receiver policy: **silent auto-accept** — root-key possession is the trust
anchor; no user interaction, no notification.

Security properties:

- Replayed leg 0 is useless: the response is boxed to an eph key the attacker
  cannot open, and nothing destructive happens before leg 2. Replayed legs 1/2
  die on the single-use pending stores (consumed on first success).
- Key replacement on both sides happens only on verified, origin-checked
  bundles (leg 1 gated by eph secret + restore_id; leg 2 gated by bundle
  verification + origin check).
- One-sided loss works: B's stale AD for A is replaced — required anyway, since
  `reseed_identity_from_secret` rolls a fresh ENCRYPT key.
- Both-sides-degraded works: no leg requires pre-existing channel keys.
- Leg 0 is a distinct transaction, so the app-hook "message from an unknown
  sender was rejected" path (`actor.mu:348`) is not involved.

### 4. Host integration (ours-mcp `index.ts`; ours-tg-connector mirrors)

- **Boot (eager):** after `restoreIdentity`, call `list_degraded_contacts` and
  fire `request_contact_restore` for each.
- **Send (lazy):** send tools return "queued, contact restore in progress"
  instead of an error when the target is degraded.
- **Retry:** peers may be offline or not yet upgraded to a version that knows
  the transaction — re-fire outstanding restores on the existing gc tick
  (`gcIntervalMs`) with an attempt cap; no reply is a normal condition.
- MCP surface: `list_contacts` marks degraded contacts; no new user-facing tool.

### Version-skew note

After a breaking release, A may upgrade before B. Until B upgrades, B cannot
parse leg 0 (unknown transaction) — the request is simply lost and retried
later. The handshake heals the link once both sides run a version that carries
it; shipping the mechanism **now**, before any breaking change exists,
maximizes coverage when the first one lands.

## Testing

- **Core (`tests/run.sh` additions):**
  - Export → strip `peer_ads` → import → `list_degraded_contacts` reports them;
    plain data (name/bio/persona/contacts/inbox) intact.
  - Full 3-leg handshake between two packets: channel restored, deferred
    messages flushed in order, both directions deliver.
  - Leg 0 from an address not in `contacts` → silently ignored, no state change.
  - Replayed leg 0 and mismatched `restore_id` → rejected, no state change.
  - `format_version` round-trip, including one synthetic version-0 → version-1
    migration exercising the contract (peer_ads dropped, contacts preserved).
- **Host (ours-mcp):** artificially break `state_data.bin` compatibility,
  reboot both daemons, assert container ids unchanged and messages flow again
  end-to-end without user action; send-to-degraded returns the queued status
  and flushes after restore.

## Out of scope

- Restoring a peer that lost its `contacts` map entirely (no migration possible
  and no backup): they genuinely no longer know the requester; re-invite is the
  correct path.
- Message-history reconciliation between peers.
- Encrypted-at-rest key/state storage.
- A separate agents.yaml / sidecar essence file — rejected in favor of the
  single-carrier `state_data.bin` + migration contract.
