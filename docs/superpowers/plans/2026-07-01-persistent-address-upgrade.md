# Persistent Container Address (adapt-toolkit #77) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve each container's address across packet recreation / version upgrades by persisting the exported root SIGN secret and reseeding the new packet from it, and ship `ours-mufl-core`, `ours-mcp`, and `ours-tg-connector` at 0.1.0.

**Architecture:** adapt-toolkit #77 derives a container's address from its SIGN public key (`address_of_key(sign_pub)`) and adds `export_identity_signing_secret()` / `reseed_identity_from_secret(secret)`. We stop persisting the seed; instead we export the SIGN secret to `identity.key` and, on every boot, recreate the packet injecting that secret as `CreatePacket`'s 6th `init_arg` so `__init` reseeds and the address is identical. `ours-mufl-core` (the shared MUFL submodule) is updated first; `ours-mcp` and `ours-tg-connector` then consume it.

**Tech Stack:** TypeScript (Node daemons), MUFL (`.mu`/`.mm` compiled to `.muflo`), `@adapt-toolkit/sdk` + `sdk-native`, local `mufl-compile` from an `ADAPT_TOOLKIT` checkout at #77.

## Global Constraints

- Release version: **0.1.0** for all three repos (first version; no consumers exist).
- Existing on-disk state is **wiped & regenerated** — no seed→key bridge, no address preservation for pre-#77 identities.
- Persisted per-identity secret: **exported root SIGN secret**, file `identity.key`, mode **0600**, plaintext. The seed is ephemeral (random, used once, never written).
- SDK npm version is **deferred** — the user supplies the #77-publishing version later. Until then compile `.muflo`s with the **local built `mufl-compile`** (`scripts/compile-mufl.sh` + `ADAPT_TOOLKIT` at #77). Do **not** bump `@adapt-toolkit/sdk` / `sdk-native` pins in this plan.
- MUFL wire-schema `$version -> N` literals are NOT the release version — never touch them.
- Signing/origin-verification is enforced by the stdlib transaction wrapper — no app/library code adds signing calls.

---

## Phase 0 — Build environment (prerequisite for every compile/verify task)

### Task 0: Stand up a #77 toolkit + verify local compile works

**Files:**
- Env only (no repo edits). Touches `ours-mcp/scripts/compile-mufl.sh` behavior.

- [ ] **Step 1: Confirm the toolkit checkout is at #77**

```bash
cd /home/shakhvit/work/adapt/adapt-toolkit
git log --oneline -1
# Expected: the tip includes 6e1344e (#77 "Verifiable message origin ...") or newer.
git grep -n "reseed_identity_from_secret" mufl_stdlib/cryptography/key_storage.mm
# Expected: a match (proves #77 primitives are present).
```

- [ ] **Step 2: Build `mufl-compile`**

```bash
cd /home/shakhvit/work/adapt/adapt-toolkit
python3 build.py --compiler_release
ls build*/mufl-compile
# Expected: a mufl-compile binary exists under build.<platform>.release/ (or build/).
```

- [ ] **Step 3: Initialize the ours-mcp core submodule**

```bash
cd /home/shakhvit/work/adapt/ours.network/ours-mcp
git submodule update --init packages/core/mufl_code/core
ls packages/core/mufl_code/core/config.mufl
# Expected: file exists.
```

- [ ] **Step 4: Baseline-compile the current ours-mcp actor against the #77 toolkit**

```bash
cd /home/shakhvit/work/adapt/ours.network/ours-mcp
ADAPT_TOOLKIT=/home/shakhvit/work/adapt/adapt-toolkit ./scripts/compile-mufl.sh
ls packages/core/mufl_code/*.muflo
# Expected: EITHER a fresh .muflo is produced (compile succeeds against #77),
# OR a compile error surfaces that reveals a #77 incompatibility to fix in later tasks.
```

Record whether the baseline compile succeeds. A failure here is data for Phase 1/2, not a blocker to reading on.

- [ ] **Step 5: Commit nothing** — this task is environment setup only.

---

## Phase 1 — `ours-mufl-core` (foundation, land first)

Repo: `/home/shakhvit/work/adapt/ours.network/ours-mufl-core`.

### Task 1: Verify (or fix) the address-derivation invariant under #77

**Files:**
- Test: `tests/run.sh` (existing loopback suite, 10 scenarios / 36 assertions)
- Possibly modify: `a2a_protocol.mm:179-180` (and any parallel P3-invariant site)

**Interfaces:**
- Consumes: #77 `key_storage::address_of_key`, `_value_id`, `_global_id_of_hash`.
- Produces: a core whose CP-attestation verification agrees with #77's address derivation.

- [ ] **Step 1: Run the suite against the #77 toolkit (expect a possible failure)**

```bash
cd /home/shakhvit/work/adapt/ours.network/ours-mufl-core
ADAPT_TOOLKIT=/home/shakhvit/work/adapt/adapt-toolkit \
OURS_SDK_NODE_MODULES=/home/shakhvit/work/adapt/ours.network/ours-mcp/node_modules/@adapt-toolkit \
DEV_BROKER=/home/shakhvit/work/adapt/ours.network/ours-mcp/scripts/dev-broker.mjs \
  ./tests/run.sh
# Expected: EITHER all 36 assertions pass (invariant still holds) — skip Steps 2-4,
# OR verify_cp_attestation / invite verification fails, proving container_id != _value_id(key_list).
```

- [ ] **Step 2: Inspect the failing assertion vs #77 derivation**

Read `a2a_protocol.mm:130-207` (`verify_cp_attestation` and the P3 commitment check at :179-180) and compare `_value_id(cp_ad $identity $key_list)` against #77's `address_of_key(sign_pub) = _global_id_of_hash(_value_id({ "adapt/addr/v1", sign_pub }))` in `adapt-toolkit/mufl_stdlib/cryptography/key_storage.mm:29-31`. Confirm the mismatch is the address derivation.

- [ ] **Step 3: Update the commitment check to the #77 derivation (only if Step 1 failed)**

Replace the `_value_id(key_list) == commitment $cid_cp` assertion with a check that derives the expected cid via the toolkit's `key_storage::address_of_key` applied to the attestation's SIGN pubkey (mirror exactly how `adapt-toolkit/mufl_stdlib/cryptography/address_document.mm:79-80` validates `container_id == address_of_key(sign_pub)`). Keep the surrounding verification shape unchanged.

- [ ] **Step 4: Re-run the suite to green**

```bash
cd /home/shakhvit/work/adapt/ours.network/ours-mufl-core
ADAPT_TOOLKIT=/home/shakhvit/work/adapt/adapt-toolkit \
OURS_SDK_NODE_MODULES=/home/shakhvit/work/adapt/ours.network/ours-mcp/node_modules/@adapt-toolkit \
DEV_BROKER=/home/shakhvit/work/adapt/ours.network/ours-mcp/scripts/dev-broker.mjs \
  ./tests/run.sh
# Expected: 36/36 assertions pass.
```

- [ ] **Step 5: Commit (only if code changed)**

```bash
git add a2a_protocol.mm
git commit -m "fix(a2a_protocol): derive CP-attestation cid via address_of_key (adapt #77)"
```

### Task 2: Verify the two bare-send invite legs under origin verification

**Files:**
- Test: `tests/run.sh` (invite-redeem scenarios + `qa_leg1_*` / `qa_send_complete` probes in `tests/test_actor.mu:182-249`)
- Possibly modify: `a2a_messaging.mm` (leg 1 send `:642` / receiver `:1332`; leg 3 send `:1416` / receiver `:1437`); comment `a2a_messaging.mm:62-64`

**Interfaces:**
- Consumes: #77 wrapper `check_origin_binding`; stdlib `transaction::action::send`; `_crypto_encrypt_message` boxing.
- Produces: invite legs that pass origin verification for not-yet-registered peers.

- [ ] **Step 1: Confirm the invite scenarios are covered by Task 1's suite run**

The `run.sh` suite already exercises leg-1/leg-2/leg-3 redeem and the `qa_*` adversarial probes. If Task 1 Step 4 is 36/36 green, the bare-send legs already pass origin verification — record this and skip to Step 4.

- [ ] **Step 2: If a leg fails, identify whether it is unsigned-reject or origin-mismatch**

Read `adapt-toolkit/transactions/__t_wrapper.mm` `check_origin_binding` (rejects `from != address_of_key(sign_pub)`) and the unsigned-enveloped reject path. Compare against the bare boxed send at `a2a_messaging.mm:642` / `:1416` and the `check_encrypted_or_abort`-skipping receivers at `:1332` / `:1437`.

- [ ] **Step 3: Adjust the affected leg (only if Step 1 failed)**

Bring the failing leg's send/receive into line with #77 (e.g. ensure the enveloped `from` matches the sender's SIGN-derived address, or route through the send path the wrapper now signs). Make the minimal change that restores the assertion; do not change the invite protocol shape.

- [ ] **Step 4: Fix the doc/code drift**

Update the comment at `a2a_messaging.mm:62-64` so it states the authoritative behavior of leg 3 (bare boxed send per code at `:1416`/`:1430`, not "rides the encrypted channel").

- [ ] **Step 5: Re-run + commit (only if code/comment changed)**

```bash
cd /home/shakhvit/work/adapt/ours.network/ours-mufl-core
ADAPT_TOOLKIT=/home/shakhvit/work/adapt/adapt-toolkit \
OURS_SDK_NODE_MODULES=/home/shakhvit/work/adapt/ours.network/ours-mcp/node_modules/@adapt-toolkit \
DEV_BROKER=/home/shakhvit/work/adapt/ours.network/ours-mcp/scripts/dev-broker.mjs \
  ./tests/run.sh
git add a2a_messaging.mm
git commit -m "fix(a2a_messaging): invite legs pass #77 origin verification; correct leg-3 comment"
# Expected: 36/36 pass.
```

### Task 3: Bump ours-mufl-core to 0.1.0 and publish

**Files:**
- Modify: `version.mm:20`

- [ ] **Step 1: Edit the version marker**

In `version.mm:20` change:

```
        core_version = create_version 0 0 1.
```

to:

```
        core_version = create_version 0 1 0.
```

- [ ] **Step 2: Re-run the suite to confirm the bump compiles**

```bash
cd /home/shakhvit/work/adapt/ours.network/ours-mufl-core
ADAPT_TOOLKIT=/home/shakhvit/work/adapt/adapt-toolkit \
OURS_SDK_NODE_MODULES=/home/shakhvit/work/adapt/ours.network/ours-mcp/node_modules/@adapt-toolkit \
DEV_BROKER=/home/shakhvit/work/adapt/ours.network/ours-mcp/scripts/dev-broker.mjs \
  ./tests/run.sh
# Expected: 36/36 pass.
```

- [ ] **Step 3: Commit and push (consumers pin this commit)**

```bash
git add version.mm
git commit -m "feat: ours-mufl-core 0.1.0 — verified against adapt #77"
git push origin main
git rev-parse HEAD   # record this SHA for the submodule bumps in Phase 2/3
```

---

## Phase 2 — `ours-mcp`

Repo: `/home/shakhvit/work/adapt/ours.network/ours-mcp`.

### Task 4 (RESOLVED — reference): how the wrapper delivers `init_arg`

Resolved from toolkit SDK source; no runtime spike needed to code the mechanism. This
task is a documentation anchor for Tasks 6 & 9 — no code, no commit.

**Confirmed mechanism** (source-verified in adapt-toolkit):
- `wrapper.packet_manager.create_packet(config, cb, contents)` computes
  `const init_arg = packet_config.init_arg ? object_to_adapt_value(JSON.parse(packet_config.init_arg)) : undefined;`
  and passes it as `CreatePacket`'s 6th arg
  (`typescript/sdk/src/utilities/wrappers/wrappers/adapt_wrapper.ts:193-194`).
- `PacketWrapperConfigurator.init_arg` is backed by the CLI arg **`--init_trn_argument`**
  (`typescript/sdk/src/utilities/wrappers/configurators/packet_wrapper_configurator.ts:88`).
- Therefore inject via
  `config.process_arguments(['--unit_hash', …, '--seed_phrase', seed, '--unit_dir_path', …, '--init_trn_argument', <jsonString>])`.
- `CreatePacket`'s 6th arg is delivered to `trn __init arg`
  (`typescript/sdk-native/adapt_js.cc:340-342`), which calls
  `reseed_identity_from_secret(arg SAFE(secretkey_sign))`.
- Authoritative passing example: `tests/Functional/29.Javascript/identity_reseed.mu` — create
  A, `export_secret`, create B with the secret as the 6th arg, assert `addressA == addressB`.

**The one runtime-confirmed detail (deferred to SDK delivery):** the wrapper's `init_arg`
path is JSON-only (`JSON.parse` → `object_to_adapt_value`), while the low-level test passes
the raw `AdaptValue` secret directly. So the exact JSON encoding of a `secretkey_sign` that
round-trips through `object_to_adapt_value` and satisfies `SAFE(secretkey_sign)` — a hex
string vs a typed-bytes object — must be confirmed when the runtime SDK lands. Tasks 6 & 9
code the **hex-string** form as primary and flag the exact line for runtime verification.

- [ ] **Step 1:** No action — reference only. Proceed to Task 5.

### Task 5: actor.mu — add `export_signing_secret` + `__init` reseed

**Files:**
- Modify: `packages/core/mufl_code/actor.mu` (add a `trn readonly export_signing_secret`; add a `trn __init arg`; update the seed-recreation design comment near `actor.mu:1391`)
- Compile: `scripts/compile-mufl.sh`

**Interfaces:**
- Consumes: #77 `key_storage::export_identity_signing_secret`, `key_storage::reseed_identity_from_secret`.
- Produces: MUFL transactions `::actor::export_signing_secret` (readonly → SIGN secret) and `::actor::__init` (arg → reseed) for the TS layer in Task 6.

- [ ] **Step 1: Add the export readonly transaction**

After the `export_address_document_native` transaction (`actor.mu:799-802`), add:

```
    // Export the root SIGN secret so the host can persist it (identity.key) and
    // reseed a recreated packet to the same address across upgrades (adapt #77).
    trn readonly export_signing_secret _
    {
        return key_storage::export_identity_signing_secret().
    }
```

- [ ] **Step 2: Add the `__init` reseed handler**

Add a top-level `__init` transaction (mirror `adapt-toolkit/tests/Functional/29.Javascript/identity_reseed.mu:26-30`):

```
    // On recreation the host injects the persisted SIGN secret as init_arg;
    // reseeding restores the container address (adapt #77). Fresh-create passes
    // no arg and the bootstrapped identity stands.
    trn __init arg
    {
        if arg { key_storage::reseed_identity_from_secret (arg SAFE(secretkey_sign)). }
    }
```

- [ ] **Step 3: Update the design comment**

At the `export_state`/upgrade comment block (around `actor.mu:1391`), replace any "recreate from the same seed (same container id + same default keys)" wording with the reseed model: the host persists the SIGN secret and injects it as `init_arg`; the address is preserved via `reseed_identity_from_secret` regardless of seed/derivation changes.

- [ ] **Step 4: Compile the unit**

```bash
cd /home/shakhvit/work/adapt/ours.network/ours-mcp
ADAPT_TOOLKIT=/home/shakhvit/work/adapt/adapt-toolkit ./scripts/compile-mufl.sh
ls packages/core/mufl_code/*.muflo packages/core/dist/mufl_code/*.muflo
# Expected: a fresh content-hashed .muflo in both locations (old one removed).
```

- [ ] **Step 5: Commit**

```bash
git add packages/core/mufl_code/actor.mu
git commit -m "feat(actor): export_signing_secret + __init reseed (adapt #77 address preservation)"
```

### Task 6: index.ts — persist/inject the SIGN secret; swap seed→key on disk

**Files:**
- Modify: `packages/core/src/index.ts` — `createPacket` (`:1661-1694`), `provisionIdentity` (`:1699-1722`), `restoreIdentity` (`:1725-1743`), `seedPath` (`:250`), `listPersistedNames` (`:267-273`), registrar seed path (`:281`, `ensureRegistrar` `:1289-1296`), the `Identity` type's `seed` field.
- Test: `scratchpad/restart_addr.mjs` (integration: create → restart → same cid)

**Interfaces:**
- Consumes: Task 4's `init_arg` mechanism; Task 5's `::actor::export_signing_secret` and `::actor::__init`.
- Produces: on-disk `identity.key` per identity; boot path that reseeds.

- [ ] **Step 1: Write the failing restart test**

Create `scratchpad/restart_addr.mjs`: start the daemon (or drive `bootWrapper` + `provisionIdentity` in-process against a temp `OURS_STATE`), create identity `t1`, capture `cid1`; tear down; re-run `restoreIdentity('t1')`; capture `cid2`. Assert `cid1 === cid2` and assert the identity dir contains `identity.key` and NOT `identity.seed`.

```bash
cd /home/shakhvit/work/adapt/ours.network/ours-mcp
OURS_STATE=$(mktemp -d) node scratchpad/restart_addr.mjs
# Expected BEFORE the change: FAIL — identity.seed present (not identity.key),
# and/or cid mismatch once seed→key derivation is bypassed.
```

- [ ] **Step 2: Add a `keyPath` helper and export/inject plumbing**

Replace `seedPath` usage. Add near `index.ts:250`:

```ts
const keyPath = (dir: string) => join(dir, 'identity.key');
```

Give `createPacket` an optional injected secret and pass it via the Task-4 mechanism
(`--init_trn_argument`, a JSON string). The `signingSecret` is the hex string persisted in
`identity.key`; JSON-encode it so `JSON.parse` in the wrapper yields that string, which
`object_to_adapt_value` maps to a string AdaptValue for `SAFE(secretkey_sign)`:

```ts
function createPacket(
  name: string, seed: string, dir: string, track = true, signingSecret?: string,
): Promise<Identity> {
  const config = new PacketWrapperConfigurator();
  const args = ['--unit_hash', UNIT.hash, '--seed_phrase', seed, '--unit_dir_path', UNIT.dir];
  // RUNTIME-VERIFY (Task 4): confirm secretkey_sign round-trips as a JSON hex string;
  // if it needs a typed-bytes object, change JSON.stringify(signingSecret) accordingly.
  if (signingSecret) args.push('--init_trn_argument', JSON.stringify(signingSecret));
  config.process_arguments(args);
  // ...unchanged body...
}
```

- [ ] **Step 3: Rework `provisionIdentity` to export + persist the SIGN secret**

```ts
  const dir = identityDir(name);
  fs.mkdirSync(dir, { recursive: true });
  const seed = randomBytes(24).toString('hex');           // ephemeral entropy, not persisted
  const id = await createPacket(name, seed, dir);
  const secret = await withScopeAsync((lt) =>
    readonlyTx(id, '::actor::export_signing_secret', undefined, lt));  // hex string
  fs.writeFileSync(keyPath(dir), secret, { mode: 0o600 });
  // ...set_my_name / pinRegistrar / localPolicy / publishToBook / saveState unchanged...
```

(Use the existing `readonlyTx` visualize/serialize convention already used for `export_address_document`; the secret must round-trip to the same hex form the wrapper accepts as `init_arg` — verified in Task 4.)

- [ ] **Step 4: Rework `restoreIdentity` to inject the secret**

```ts
  const dir = identityDir(name);
  const secret = fs.readFileSync(keyPath(dir), 'utf8').trim();
  const id = await createPacket(name, '', dir, true, secret);   // seed unused; reseed sets cid
  if (hasSavedState(dir)) { /* unchanged import_state block */ }
```

- [ ] **Step 5: Update `listPersistedNames`, registrar seed, and the `Identity` type**

Change `listPersistedNames` (`:267-273`) to treat a dir containing `identity.key` as persisted. Apply the same export/inject swap to the contact-book registrar (`registrarSeedPath` `:281` → `registrar.key`; `ensureRegistrar` `:1289-1296`). Change the `Identity` `seed: string` field to `signingSecret: string` (or drop it) and fix references.

- [ ] **Step 6: Rebuild and run the restart test to green**

```bash
cd /home/shakhvit/work/adapt/ours.network/ours-mcp
npm run -w @ours.network/mcp build
OURS_STATE=$(mktemp -d) node scratchpad/restart_addr.mjs
# Expected: PASS — cid1 === cid2; identity.key present, identity.seed absent.
```

- [ ] **Step 7: Verify messaging + broker registration still work**

Drive two local identities (or reuse an existing smoke script) through the dev broker: create, exchange an invite, send a message, confirm receipt (proves #77 origin verification passes end-to-end and broker registration/possession-proof succeeds via the SDK wrapper).

```bash
cd /home/shakhvit/work/adapt/ours.network/ours-mcp
node scripts/dev-broker.mjs &   # if not already running
OURS_STATE=$(mktemp -d) node scratchpad/smoke_two_identities.mjs
# Expected: message delivered; no origin-verification rejection; both register on broker.
```

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/index.ts
git commit -m "feat(daemon): persist exported SIGN secret (identity.key) + reseed on boot (adapt #77)"
```

### Task 7: Bump ours-mcp to 0.1.0 and update the submodule

**Files:**
- Modify: `package.json:3`, `packages/core/package.json:3`, `packages/claude-code/package.json:3`, `packages/claude-code/package.json:47` (pinned `@ours.network/mcp` dep), `packages/claude-code/.claude-plugin/plugin.json:6`
- Modify: submodule pointer `packages/core/mufl_code/core`

- [ ] **Step 1: Bump the five version strings to 0.1.0**

Set each of the following to `"version": "0.1.0"` (and the pinned dep at `packages/claude-code/package.json:47` to `"@ours.network/mcp": "0.1.0"`):
- `package.json:3`
- `packages/core/package.json:3`
- `packages/claude-code/package.json:3`
- `packages/claude-code/.claude-plugin/plugin.json:6`

- [ ] **Step 2: Point the core submodule at the Phase-1 commit**

```bash
cd /home/shakhvit/work/adapt/ours.network/ours-mcp/packages/core/mufl_code/core
git fetch origin main && git checkout <SHA-from-Task-3-Step-3>
cd /home/shakhvit/work/adapt/ours.network/ours-mcp
```

- [ ] **Step 3: Refresh the lockfile and rebuild the unit against the new core**

```bash
npm install --package-lock-only
ADAPT_TOOLKIT=/home/shakhvit/work/adapt/adapt-toolkit ./scripts/compile-mufl.sh
```

- [ ] **Step 4: Verify the daemon boots and reports v0.1.0**

```bash
cd /home/shakhvit/work/adapt/ours.network/ours-mcp
npm run -w @ours.network/mcp build
OURS_STATE=$(mktemp -d) node packages/core/dist/index.js --status 2>&1 | grep -i "v0.1.0"
# Expected: startup log shows "MCP server v0.1.0 ready ...".
```

- [ ] **Step 5: Commit**

```bash
git add package.json packages/core/package.json packages/claude-code/package.json \
        packages/claude-code/.claude-plugin/plugin.json package-lock.json \
        packages/core/mufl_code/core
git commit -m "chore(release): ours-mcp 0.1.0 — adapt #77 core submodule"
```

---

## Phase 3 — `ours-tg-connector`

Repo: `/home/shakhvit/work/adapt/ours.network/ours-tg-connector`. Mirrors Phase 2; reuses the Task-4 `init_arg` mechanism. This repo has **no local compile step** — the `.muflo` is compiled externally (Step in Task 8) and committed.

### Task 8: actor.mu + recompiled `.muflo` — export/reseed

**Files:**
- Modify: `mufl_code/actor.mu` (add `trn readonly export_signing_secret`; add `trn __init arg`; revise the seed-recreation comment `actor.mu:1335-1345`)
- Update submodule: `mufl_code/core` → Phase-1 SHA
- Replace: `mufl_code/FEEDE00E….muflo` with the freshly compiled unit

**Interfaces:**
- Consumes: #77 `key_storage` functions; Task 4 `init_arg` mechanism.
- Produces: `::actor::export_signing_secret` and `::actor::__init` for the connector's TS layer (Task 9).

- [ ] **Step 1: Point the core submodule at the Phase-1 commit**

```bash
cd /home/shakhvit/work/adapt/ours.network/ours-tg-connector/mufl_code/core
git fetch origin main && git checkout <SHA-from-Task-3-Step-3>
```

- [ ] **Step 2: Add the two transactions (identical to Task 5 Steps 1-2)**

Add to `mufl_code/actor.mu`:

```
    trn readonly export_signing_secret _
    {
        return key_storage::export_identity_signing_secret().
    }

    trn __init arg
    {
        if arg { key_storage::reseed_identity_from_secret (arg SAFE(secretkey_sign)). }
    }
```

- [ ] **Step 3: Revise the seed-recreation comment**

At `mufl_code/actor.mu:1335-1345`, replace the "recreates this packet from the same seed (same container id + same default keys)" wording with the reseed-from-persisted-secret model (as in Task 5 Step 3).

- [ ] **Step 4: Compile the connector unit externally**

This repo has no compiler. Compile via the toolkit directly against the updated `mufl_code/core`, e.g. by pointing an adapted `compile-mufl.sh` (copied from ours-mcp) at this repo's `actor.mu`, OR invoke `mufl-compile` as ours-mcp's script does with `MUFL_STDLIB_PATH=$ADAPT_TOOLKIT/mufl_stdlib` and `-mp $ADAPT_TOOLKIT/meta -mp $ADAPT_TOOLKIT/transactions`. Produce the new content-hashed `.muflo`.

```bash
# from a scratch copy that assembles actor.mu + mufl_code/core/*.mm + config.mufl
ADAPT_TOOLKIT=/home/shakhvit/work/adapt/adapt-toolkit mufl-compile \
  -mp $ADAPT_TOOLKIT/meta -mp $ADAPT_TOOLKIT/transactions -d-c actor.mu
# Expected: a new <HASH>.muflo.
```

- [ ] **Step 5: Swap the committed unit**

Remove the old `mufl_code/FEEDE00E….muflo`; copy the new `.muflo` into `mufl_code/` (and `dist/mufl_code/` if `build.mjs` copies it — confirm `locateUnit()` in `src/adapt.ts:69-85` finds exactly one).

- [ ] **Step 6: Commit**

```bash
git add mufl_code/actor.mu mufl_code/core mufl_code/*.muflo
git rm --cached mufl_code/FEEDE00E857F43BB3D6AFE70518AF64E4EA327A5D650B7A0D3A17F7F3CBAFFA2.muflo 2>/dev/null || true
git commit -m "feat(actor): export_signing_secret + __init reseed; recompiled unit (adapt #77)"
```

### Task 9: connector TS — persist/inject the SIGN secret

**Files:**
- Modify: `src/adapt.ts:243-266` (`createPacket` — inject `init_arg`), `src/connector.ts:138-141` (`seedPath` → `keyPath`), `:616-617` (write), `:669-670` (read/inject)
- Test: `scratchpad/restart_addr.mjs` (connector variant)

**Interfaces:**
- Consumes: Task 8's `::actor::export_signing_secret` / `::actor::__init`; Task 4 `init_arg` mechanism.
- Produces: `identity.key` per route; boot reseeds so `GetContainerID()` is stable.

- [ ] **Step 1: Write the failing restart test**

Create `scratchpad/restart_addr.mjs` for the connector: create route `r1` (capture `cid1`), restart, `restoreConnection('r1')` (capture `cid2`), assert `cid1 === cid2` and that the route dir holds `identity.key` not `identity.seed`.

```bash
cd /home/shakhvit/work/adapt/ours.network/ours-tg-connector
node scratchpad/restart_addr.mjs   # Expected: FAIL (still writes identity.seed)
```

- [ ] **Step 2: Inject `init_arg` in `createPacket`**

In `src/adapt.ts:243-266`, add an optional `signingSecret` param and push Task 4's verified `init_arg` form into `process_arguments` when present (mirror Task 6 Step 2).

- [ ] **Step 3: Persist the exported secret on create**

In `src/connector.ts`: rename the path helper to `keyPath = (dir) => join(dir, 'identity.key')` (`:138-141`). At create (`:616-617`), after `createPacket`, call `::actor::export_signing_secret`, write `identity.key` (mode 0600), and stop writing the seed. At restore (`:669-670`), read `identity.key` and pass it as `signingSecret` to `createPacket`.

- [ ] **Step 4: Rebuild and run the restart test to green**

```bash
cd /home/shakhvit/work/adapt/ours.network/ours-tg-connector
npm run build
node scratchpad/restart_addr.mjs   # Expected: PASS — cid stable; identity.key present.
```

- [ ] **Step 5: Commit**

```bash
git add src/adapt.ts src/connector.ts
git commit -m "feat(connector): persist exported SIGN secret + reseed on boot (adapt #77)"
```

### Task 10: Bump ours-tg-connector to 0.1.0

**Files:**
- Modify: `package.json:3`

- [ ] **Step 1: Bump the version**

Set `package.json:3` to `"version": "0.1.0"`. (The shared-core version was bumped in Phase 1 and enters via the submodule pointer set in Task 8 Step 1.)

- [ ] **Step 2: Refresh the lockfile and typecheck/build**

```bash
cd /home/shakhvit/work/adapt/ours.network/ours-tg-connector
npm install --package-lock-only
npm run build
# Expected: clean build.
```

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(release): ours-tg-connector 0.1.0"
```

---

## Self-Review

**Spec coverage:**
- Address-from-signing-key derivation + P3 invariant → Task 1. ✔
- Signed/origin-verified enveloped messages (bare invite legs) → Task 2, Task 6 Step 7. ✔
- Export/reseed MUFL surface → Task 5 (mcp), Task 8 (tg). ✔
- Persist SIGN secret / drop seed / 0600 → Task 6 (mcp), Task 9 (tg). ✔
- `init_arg` delivery unknown → Task 4 spike, reused in Tasks 6 & 9. ✔
- Wipe & regenerate → covered by dropping `identity.seed` and keying persistence off `identity.key` (fresh state); no bridge task, by design. ✔
- Version 0.1.0 (core / mcp 5 files / tg) → Task 3, Task 7, Task 10. ✔
- Submodule bump propagation → Task 7 Step 2, Task 8 Step 1. ✔
- Broker possession-proof "for free" via SDK → verified in Task 6 Step 7. ✔
- Local `mufl-compile`, SDK pin deferred → Global Constraints + Task 0; no SDK-pin task. ✔
- Recompile tg `.muflo` externally → Task 8 Step 4-5. ✔

**Placeholder scan:** Spike/verify tasks (0, 1, 2, 4) legitimately branch on a runtime outcome, but each states the exact commands, the expected pass/fail signal, and the concrete fix location — no "add error handling"/"TBD" placeholders. Code tasks (5, 6, 8, 9) carry verbatim MUFL/TS.

**Type consistency:** `signingSecret` (TS param) / `identity.key` (file) / `keyPath` (helper) / `::actor::export_signing_secret` / `::actor::__init` / `reseed_identity_from_secret` / `export_identity_signing_secret` used consistently across Tasks 4–9. The Task-6 `--init_arg` form is explicitly a placeholder for Task 4's verified mechanism, flagged at each use.

## Known dependencies & risks

- **Task 4 gates Tasks 6 & 9.** If only low-level `CreatePacket` carries `init_arg`, the daemons may need a wrapper change or a documented lower-level path — surfaced in Task 4 Step 4 before any daemon edit.
- **Task 1 may cascade.** If the P3 invariant broke, address-document/attestation verification across the ecosystem changes; re-run Task 6 Step 7 and the tg smoke after any `a2a_protocol.mm` edit.
- **SDK pin.** When the user supplies the #77-publishing SDK version, bump `@adapt-toolkit/sdk` + `sdk-native` in `ours-mcp/packages/core/package.json` and `ours-tg-connector/package.json`, re-run Task 0 against the npm SDK, and re-confirm Task 4's mechanism against it.
