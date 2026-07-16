# PENDING — toolkit publish gates this branch (do NOT push yet)

**Branch:** `feat/migration-core-bump` (off `origin/prerelease`) · **Owner:** MigrationConverge · **Date:** 2026-07-16
**State:** HELD at pre-push gate on FleetCoordinator's instruction. PRERELEASE only, never `main`, never prod `:3050`.

## What this branch already contains (proven correct)
1. **Submodule bump** `packages/core/mufl_code/core` → `9bb4ad1` (ours-mufl-core migration core;
   on pushed `origin/feat/migration-impl`, CI-reachable by SHA).
2. **`actor.mu`** — `a2a_capabilities::init` now gets `$advertise -> [cap_e2e, cap_e2e_migrate]`
   plus the `cap_e2e_migrate` manifest entry (both caps advertised by default → `mig_should_trigger`
   fires for an already-e2e pair). Byte-identical to MigrationTestDriver's proven change.
3. **`package.json`** — devDependency `@adapt-toolkit/mufl` set to a **placeholder** (see below).

## Compile proof (local, not pushed)
- With **CI-pinned** compiler `npm @adapt-toolkit/mufl@0.9.1`: **FAILS** → `File 'e2e.mm' not found`.
- With **local raised-ceiling** toolkit `/home/fleet/work/migration-impl-adapt`: **SUCCEEDS** (28s, META STAGE) →
  unit hash `1DA08F71` → **`2F94AB0B`**, 170 migration symbols in the `.muflo`
  (`::a2a_messaging::advertise_migrate`, `cap_e2e_migrate`×12, `mig_offer`, `signed_prekey`, `olm`…).
- `npm run typecheck`: GREEN.

## THE BLOCKER — prerequisite before this branch can land
The published `@adapt-toolkit/mufl@0.9.1` (what CI's `npm ci` + `scripts/compile-mufl.sh` uses) is missing BOTH:
1. **`mufl_stdlib/cryptography/e2e.mm`** — the Olm double-ratchet stdlib the migration core `imports libraries e2e`.
2. **`META_REDUCTION_MAX_STEPS >= 1<<22`** (4194304). The migration daemon packet uses ~1.05–1.5M meta-reduction
   steps; 0.9.1 still has the old `1<<20` (1048576) ceiling → would exhaust fuel even if e2e.mm were present.

Both requirements exist today only in the local toolkit source `/home/fleet/work/migration-impl-adapt`
(commit `b18e1cb`, `src/eval/meta_reduction_fuel.h:43`). That toolkit is **unpublished**.

## The atomic-landing procedure (once the e2e-enabled @adapt-toolkit/mufl is PUBLISHED)
1. In `package.json`, replace the placeholder `"@adapt-toolkit/mufl": "PENDING-e2e-stdlib-and-raised-ceiling"`
   with the **exact published version** that ships `cryptography/e2e.mm` + raised ceiling. Remove `_pendingToolkitBump`.
2. `npm install` to regenerate `package-lock.json` for the new compiler (CI uses `npm ci` → lockfile must match).
3. Re-run the gate with the **published** toolkit (no `ADAPT_TOOLKIT` override):
   `scripts/compile-mufl.sh` must SUCCEED and produce a unit with migration symbols (hash != `1DA08F71`,
   expect the `2F94AB0B`-class migration unit). Then `npm run typecheck && npm run build && npm test` green.
4. Report the published-toolkit compile proof to FleetCoordinator. **Only on explicit go**, push
   `feat/migration-core-bump` → `prerelease`. CI publishes nightly `0.12.0-nightly.3` (`--tag nightly`;
   `@latest` stays `0.11.2`).
5. Verify published: `npm view @ours.network/mcp dist-tags` → `@latest`=`0.11.2`, `@nightly`=`0.12.0-nightly.3`;
   download the nightly `.tgz`, confirm `dist/mufl_code/*.muflo` has migration symbols.

**Until step 1's version is real, this branch MUST NOT be pushed — CI would fail the compile.**
