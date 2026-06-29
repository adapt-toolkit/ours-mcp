# Build notes

## Building

```sh
npm ci
npm run typecheck
npm run build
npm test
```

`npm run build` (esbuild) bundles each package into `dist/`. The MCP server also
needs the compiled MUFL packet (`*.muflo`) under `packages/core/mufl_code/`, which
is **not** committed — it is a regenerated build artifact (see `.gitignore`).

## Regenerating the MUFL packet

The packet is compiled from `packages/core/mufl_code/{actor.mu,config.mufl}` plus
the shared protocol modules in the `ours-mufl-core` submodule
(`packages/core/mufl_code/core/`). With a built ADAPT toolkit on disk:

```sh
git submodule update --init
ADAPT_TOOLKIT=/path/to/adapt scripts/compile-mufl.sh
```

This drops a content-hash-named `*.muflo` into `packages/core/mufl_code/` (and
`packages/core/dist/mufl_code/`), which `npm run build` then copies into `dist/`.

## Known issue — runtime packet vs. pinned SDK (toolchain skew)

The daemon loads the compiled `*.muflo` at startup via `@adapt-toolkit/sdk-native`
(pinned at `0.5.14`). When this repo was created, the on-disk ADAPT toolkit
`mufl-compile` had been rebuilt to a newer format whose content-hashing disagrees
with `sdk-native@0.5.14`, so a freshly compiled packet fails to load:

```
EVAL_ERROR: Hash code mismatch in loaded eval unit main expected <name> got <hash>
```

This is a **pre-existing toolchain version skew, independent of the rebrand**:

- The packet compiled from this repo's sources is **brand-correct** — it embeds the
  `network.ours.mcp` app-id and contains zero references to the previous brand.
- The fix is to reconcile the toolkit `mufl-compile` with
  `@adapt-toolkit/sdk-native@0.5.14` (use a `mufl-compile` matching the pinned SDK,
  or advance the SDK pin to match the compiler). The SDK pin is intentionally **not**
  changed here.

### Impact on tests

`npm test` splits into packet-independent unit tests and daemon-boot integration
tests:

| Test | Needs a loadable packet? | Status |
|------|--------------------------|--------|
| `packages/core/test/validate-name.test.mjs` | no | passes |
| `packages/core/test/files-helpers.test.mjs` | no | passes |
| `packages/core/test/version-advisory.test.mjs` | no | passes |
| `packages/claude-code/test/proxy-resolve.test.mjs` | no | passes |
| `packages/core/test/loopback-bind.test.mjs` | yes | blocked by toolchain skew |
| `packages/core/test/lease-binding.test.mjs` | yes | blocked by toolchain skew |
| `packages/core/test/session-restore.test.mjs` | yes | blocked by toolchain skew |
| `packages/core/test/daemon-restart-resume.test.mjs` | yes | blocked by toolchain skew |

`typecheck` and `build` pass today; the daemon-boot tests pass once the packet
loads (toolchain reconciled).
