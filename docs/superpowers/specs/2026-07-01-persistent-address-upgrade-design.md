# Spec: Persistent container address via signing-key export/reseed (adapt-toolkit #77 integration)

**Date:** 2026-07-01
**Status:** Approved design
**Scope:** `ours-mufl-core` → `ours-mcp` + `ours-tg-connector` (coordinated multi-repo change)
**Release:** 0.1.0 (first version; no published/consumed builds exist yet)

## Problem

adapt-toolkit change #77 ("Verifiable message origin + broker possession-proof
registration") changes how a container's **address** (container id) is derived and adds
verifiable message origin. Before #77 the address was derived transitively from the
`--seed_phrase` (seed → RNG → keys → address), and ours-mcp / ours-tg-connector both
persist only that seed (`identity.seed`) and recreate the packet from it on every boot,
relying on "same seed ⇒ same address."

Under #77 the address is a pure function of the **root SIGN public key**:

```
address_of_key(sign_pub) = _global_id_of_hash(_value_id({ "adapt/addr/v1", sign_pub }))
```

`bootstrap_identity` mints this at library init and calls `_set_container_id`. The seed
still only seeds the RNG that *generates* a fresh SIGN key when none is injected. This
makes the "recreate from seed" model fragile: any change to seed→key derivation across
SDK versions silently changes the address. #77 also (a) makes every enveloped message
signed + origin-verified (unsigned enveloped inbound is **rejected**), (b) adds a broker
possession-proof at registration, and (c) simplifies the encrypted-channel first-contact
handshake.

## Goal

Preserve a container's address across packet recreation and version upgrades by
persisting the **exported root SIGN secret** and **reseeding** the new packet from it,
instead of relying on the seed. Ship the ecosystem at **0.1.0**.

## Key upstream primitives (adapt-toolkit #77)

- `key_storage::export_identity_signing_secret()` → returns the default SIGN secret key.
- `key_storage::reseed_identity_from_secret(secret)` → wipes key maps, rebuilds the SIGN
  keypair from `secret`, re-derives `addr = address_of_key(sign_pub)`, `_set_container_id`,
  rolls a fresh ENCRYPT key. **Same secret ⇒ same address.**
- New packets receive the secret via `CreatePacket`'s 6th `init_arg`, delivered to the
  packet's `__init` transaction.
- Reference example: toolkit `tests/Functional/29.Javascript/identity_reseed.mu` — create
  A, export secret, create B with a *different* seed but `init_arg = secretA`, assert
  `addressA == addressB`.
- Origin verification: `transactions/__t_wrapper.mm::check_origin_binding` rejects a
  message whose `from` ≠ `address_of_key(sign_pub)`; unsigned enveloped messages rejected.
- Broker registration possession-proof: `registration_proof::create/verify`.

## Locked decisions

1. **Wipe & regenerate** existing on-disk state (`~/.ours`, `~/.ours-telegram`). Pre-#77
   addresses are unrecoverable (old toolkit can't export the SIGN secret and derived the
   address differently) and there are no real users. No seed→signing-key bridge is built.
2. Persisted per-identity material becomes the **exported root SIGN secret**
   (`identity.key`), **replacing `identity.seed`**. The seed becomes ephemeral: random,
   used once to first-mint keys, then discarded (never written to disk).
3. `identity.key` stored **plaintext, mode 0600** — matches today's `identity.seed`
   handling; the SIGN secret is equally sensitive. Encryption at rest is deferred.
4. **Dependency order:** update `ours-mufl-core` first (foundation), then integrate into
   `ours-mcp` and `ours-tg-connector` (which can proceed in parallel once the core and the
   shared `init_arg` spike are resolved).

## Design

### Identity lifecycle (both daemons)

**Create** (`provisionIdentity` / route create):
1. Generate a random ephemeral seed.
2. `create_packet(seed)` — the #77 toolkit's `bootstrap_identity` mints the SIGN key from
   the seed RNG and sets `cid = address_of_key(sign_pub)`.
3. Call new readonly `export_signing_secret` transaction → obtain the SIGN secret.
4. Write the secret to `<state>/<name>/identity.key` (mode 0600). **Do not persist the seed.**

**Boot / restore** (`restoreIdentity` / `restoreConnection`) — this is *every* boot, since
both daemons already always "create a fresh packet + `import_state`", never a native
packet snapshot:
1. Read `identity.key`.
2. `create_packet` **injecting the secret as `init_arg`** → `__init` calls
   `reseed_identity_from_secret(arg)` → `cid` restored identically regardless of SDK/
   derivation changes.
3. `import_state` replays `state_data.bin` as today (code-independent DATA blob from
   `export_state`; survives `.muflo` hash changes).

`listPersistedNames` keys off `identity.key` instead of `identity.seed`. The contact-book
registrar (ours-mcp) follows the same swap (`registrar.seed` → `registrar.key`).

### Why this is the "environment prep for upgrade"

Because the SIGN secret is persisted from day one under 0.1, every future upgrade
(0.1→0.2, SDK bump, `.muflo` recompile) preserves the address by **reseed-from-secret +
`import_state`** — no dependency on seed→key derivation stability. The general flow the
user described ("load old container, export data + root signing key, load into new packet
restoring the signing key") *is* this boot path. No one-time seed bridge is needed because
we wipe.

## Per-repo changes

### Repo A — `ours-mufl-core` (foundation, land first)

Minimal by design: signing/origin-verification is enforced by the stdlib wrapper, not core
code. The core neither derives addresses nor touches seeds/keys beyond signatures.

1. **Version bump** — `version.mm:20`: `create_version 0 0 1` → `create_version 0 1 0`.
2. **VERIFY-OR-FIX the address-derivation invariant (top risk).** `verify_cp_attestation`
   asserts `_value_id(cp_ad $identity $key_list) == commitment $cid_cp`
   (`a2a_protocol.mm:179-180`), i.e. `container_id == _value_id(key_list)`. #77 derives the
   address as `_global_id_of_hash(_value_id({ "adapt/addr/v1", sign_pub }))`. If these no
   longer match, CP-attestation verification breaks. Run `tests/run.sh` against a #77
   toolkit; if it breaks, update the commitment check(s) in `a2a_protocol.mm` (and any
   parallel P3-invariant sites) to the new `address_of_key` derivation.
3. **VERIFY the two bare-send invite legs under origin verification.** Leg 1
   (`a2a_messaging.mm:642`, receiver `:1332`) and Leg 3 (`:1416`, receiver `:1437`) send
   BARE boxed messages and *skip* `check_encrypted_or_abort`. Confirm #77's auto-signature
   is accepted and origin-verification does not reject a not-yet-registered peer. Resolve
   the doc/code drift at `a2a_messaging.mm:62-64` (comment says leg 3 rides the encrypted
   channel; code is a bare boxed send) — make comment match authoritative behavior.
4. No new key-management surface here — `export_identity_signing_secret` /
   `reseed_identity_from_secret` are the consumer actor's job, not the core's.

Verification: `tests/run.sh` (10 scenarios / 36 assertions) green against the #77 toolkit.
Then commit + push; consumers bump their submodule pointer.

### Repo B — `ours-mcp`

**MUFL `actor.mu`:**
- Add `trn readonly export_signing_secret _ { return key_storage::export_identity_signing_secret(). }`
- Add `__init` arg handling: `if arg { key_storage::reseed_identity_from_secret(arg SAFE(secretkey_sign)). }`
- Update the seed-stable-recreation design comment to the reseed model.
- Recompile via local `scripts/compile-mufl.sh` against the #77 `ADAPT_TOOLKIT` checkout
  and the updated `mufl_code/core` submodule.

**TS `src/index.ts`:**
- `createPacket`: accept an optional `signingSecret`; when present, deliver it as the
  packet's `init_arg` (see Shared spike).
- `provisionIdentity`: after create, call `export_signing_secret`, write `identity.key`
  (0600), discard seed. `restoreIdentity`: read `identity.key`, inject on create, then
  `import_state`. Swap `seedPath`→`keyPath`; update `listPersistedNames` and the registrar
  seed path.
- Version flows from `package.json` via `__OURS_VERSION__` — no literal edit.

**Version bump to 0.1.0 (5 files):** `package.json`, `packages/core/package.json`,
`packages/claude-code/package.json` (+ its pinned `@ours.network/mcp` dep),
`packages/claude-code/.claude-plugin/plugin.json`; then `npm install --package-lock-only`.

**Submodule:** bump `mufl_code/core` to the updated ours-mufl-core commit.

**Broker possession-proof:** expected to come "for free" via the SDK wrapper's
registration once the SDK is bumped — verify against a live/dev broker.

### Repo C — `ours-tg-connector` (mirrors B)

**MUFL `mufl_code/actor.mu`:** same two edits (`export_signing_secret` readonly trn;
`__init` reseed) + revise the seed-stable-recreation comment (`actor.mu:1335-1345`).

**TS:**
- `src/adapt.ts:243-266` `createPacket`: inject the SIGN secret as `init_arg` (shared
  spike solution) instead of / alongside `--seed_phrase`; `GetContainerID()` stays stable.
- `src/connector.ts:616-617` (write) and `:669-670` (read): persist/consume `identity.key`
  instead of `identity.seed`.

**Recompile the `.muflo`:** this repo has **no local compile step** — it ships a prebuilt
unit. The new `actor.mu` must be compiled externally (toolkit / ours-mcp compile chain)
and the resulting `.muflo` committed, replacing `FEEDE00E….muflo`.

**Version bump to 0.1.0:** `package.json:3`; submodule `mufl_code/core/version.mm:20`
(via the submodule bump). SDK pins `0.5.14` → the #77 SDK version (deferred, see below).

**Broker possession-proof:** same as ours-mcp — verify; note `--test_mode` is passed.

## Shared spike (single unknown, blocks both daemons' boot path)

Both daemons create packets via `wrapper.packet_manager.create_packet(config, cb, contents)`
with `config.process_arguments(['--seed_phrase', …])` — **there is no `init_arg` on this
path today**. #77's reseed needs the SIGN secret delivered as `CreatePacket`'s 6th
`init_arg`. Determine, against the #77 SDK/wrapper, whether the wrapper exposes it as:
(a) a `--init_arg` config flag, (b) an extra `create_packet` parameter, or (c) requires
dropping to the lower-level `CreatePacket` (which loses the wrapper's broker/handler
wiring). Resolve once in `ours-mcp` (it has the local compile + native SDK on hand); reuse
the identical solution in `ours-tg-connector`. Everything else is deterministic; this gates
the reseed boot path.

## SDK version handling

Runtime execution uses the npm `@adapt-toolkit/sdk` + `sdk-native` (currently `0.5.14`,
pre-#77). The pinned SDK version is **deferred** until the pipeline publishes the #77 SDK;
the user will supply the version. Until then, use the **local built `mufl-compile`** (via
`scripts/compile-mufl.sh` + `ADAPT_TOOLKIT` checkout at #77) to produce the `.muflo`s. The
`init_arg` spike and any wrapper-API decision are re-confirmed once the real SDK version is
pinned.

## Testing

- **ours-mufl-core:** `tests/run.sh` green against #77 toolkit (invite legs, export
  secrecy, import migration, P3 invariant).
- **MUFL reseed round-trip** (both actors): mirror `identity_reseed.mu` — create A, export
  secret, recreate B with injected secret, assert `addressA == addressB`; `export_state`/
  `import_state` replay intact.
- **ours-mcp / ours-tg-connector TS:** create → persist `identity.key` → restart → boot
  reseeds → same `cid`; message send/receive still works post-recompile (origin
  verification passes); broker registration succeeds (possession-proof).

## Out of scope for 0.1

- Encrypted-at-rest key storage (passphrase / OS keychain).
- Preserving pre-#77 addresses (wipe & regenerate).
- Human-readable BIP39 mnemonics.
- Pinning the npm SDK version (deferred until published; local `mufl-compile` for now).
- Any seed→signing-key migration bridge for existing on-disk identities.
