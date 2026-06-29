// Bundles the Claude Code plugin's hook runner into self-contained JS.
//
// Output:
//   dist/hooks/runner.js   ← Hook runner (referenced from hooks/hooks.json)
//
// The runner imports only Node built-ins (fs/os/path) and reads per-identity
// state off disk — it never imports the core server, so it bundles standalone.
//
// Published builds are minified; `npm run build:dev` (OURS_BUILD_DEV=1)
// keeps readable output for debugging.
//
// Run via `npm run build` from inside packages/claude-code/.

import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const dist = resolve(root, 'dist');
const dev = !!process.env.OURS_BUILD_DEV;

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await build({
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  minify: !dev,
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: 'info',
  entryPoints: [resolve(root, 'src/hooks/runner.ts')],
  outfile: resolve(dist, 'hooks/runner.js'),
});
