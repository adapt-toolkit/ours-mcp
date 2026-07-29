// Bundles the agent-agnostic ours MCP server into self-contained JS.
// Each entry becomes a single ESM file with all node_modules inlined.
//
// Outputs:
//   dist/index.js          ← MCP server (loaded at runtime by dist/cli.js)
//   dist/cli.js            ← daemon CLI (ours-mcp start/stop/status/serve/proxy/watch)
//   dist/mufl_code/*.muflo ← the COMPILED ADAPT packet only (no .mu/.mm source)
//
// Published builds are minified (raises the reverse-engineering bar). For a
// readable build with intact stack traces, run `npm run build:dev`
// (OURS_BUILD_DEV=1), which disables minification.
//
// Run via `npm run build` from inside packages/core/.

import { build } from 'esbuild';
import { mkdir, rm, cp, readdir } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const dist = resolve(root, 'dist');
const dev = !!process.env.OURS_BUILD_DEV;

// Single source of truth for the version — read package.json so the reported
// version always matches the published package (the CI version bumper only
// touches package.json, never src).
const pkgVersion = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  // Minify published bundles; keep readable output for `build:dev`.
  minify: !dev,
  // Make `import.meta.url` work post-bundle.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  // Inline the package version (see src/index.ts __OURS_VERSION__).
  define: { __OURS_VERSION__: JSON.stringify(pkgVersion) },
  // The ADAPT SDK pulls in a native NAPI addon and a WASM blob that cannot be
  // bundled — keep it external and resolve it from node_modules at runtime (it
  // is a real `dependency`). Everything else (MCP SDK, zod) is pure JS and gets
  // inlined so the bundle stays self-contained.
  external: ['@adapt-toolkit/sdk', '@adapt-toolkit/sdk/*', '@adapt-toolkit/sdk-native'],
  logLevel: 'info',
};

await build({
  ...shared,
  entryPoints: [resolve(root, 'src/index.ts')],
  outfile: resolve(dist, 'index.js'),
});

// The daemon CLI (ours-mcp start/stop/status/serve). It loads dist/index.js at
// runtime via a computed specifier, so the two bundles stay separate.
await build({
  ...shared,
  entryPoints: [resolve(root, 'src/cli.ts')],
  outfile: resolve(dist, 'cli.js'),
});

// Pure file helpers (mimeFromExt / sanitizeFilename). index.ts inlines these when
// it imports './files.js', but emit them as a standalone module too so the
// unit test (test/files-helpers.test.mjs) can import ../dist/files.js directly.
await build({
  ...shared,
  entryPoints: [resolve(root, 'src/files.ts')],
  outfile: resolve(dist, 'files.js'),
});

// Pure inbox helpers (get_messages encryption-type derivation / JSON payload).
// index.ts inlines these via './inbox.js'; emit a standalone module too so the
// unit test (test/inbox-encryption.test.mjs) can import ../dist/inbox.js directly.
await build({
  ...shared,
  entryPoints: [resolve(root, 'src/inbox.ts')],
  outfile: resolve(dist, 'inbox.js'),
});

// Same deal for the voice-message detection/transcription helpers
// (test/transcribe-detect.test.mjs imports ../dist/transcribe.js directly).
await build({
  ...shared,
  entryPoints: [resolve(root, 'src/transcribe.ts')],
  outfile: resolve(dist, 'transcribe.js'),
});

// Pure Linux process-state parser used by daemon stop polling.
await build({
  ...shared,
  entryPoints: [resolve(root, 'src/process-state.ts')],
  outfile: resolve(dist, 'process-state.js'),
});

// Pure/setup helpers used by focused config-transaction tests.
await build({
  ...shared,
  entryPoints: [resolve(root, 'src/voice-setup.ts')],
  outfile: resolve(dist, 'voice-setup.js'),
});

// Structured daemon-startup progress + bounded wait helpers. index.ts and
// cli.ts inline these, while the standalone output keeps the deterministic
// timeout/rendering contract directly unit-testable.
await build({
  ...shared,
  entryPoints: [resolve(root, 'src/startup-progress.ts')],
  outfile: resolve(dist, 'startup-progress.js'),
});

// SSE keepalive (the 300s inter-chunk-timeout fix). index.ts imports it via
// './sse-keepalive.js'; emit a standalone module too so test/sse-keepalive.test.mjs
// can drive the REAL shipped function against a real HTTP server + the real MCP
// transport, rather than a copy of it living in the test.
await build({
  ...shared,
  entryPoints: [resolve(root, 'src/sse-keepalive.ts')],
  outfile: resolve(dist, 'sse-keepalive.js'),
});

// Ship ONLY the compiled MUFL packet (*.muflo) — never the .mu/.mm/.mufl source.
// The MCP server loads the .muflo at runtime from dist/mufl_code/ by hash.
const muflSrc = resolve(root, 'mufl_code');
if (existsSync(muflSrc)) {
  await mkdir(resolve(dist, 'mufl_code'), { recursive: true });
  for (const entry of await readdir(muflSrc, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.muflo')) {
      await cp(resolve(muflSrc, entry.name), resolve(dist, 'mufl_code', entry.name));
    }
  }
}
