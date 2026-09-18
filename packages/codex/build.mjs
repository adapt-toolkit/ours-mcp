import { rm, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const root = dirname(fileURLToPath(import.meta.url));
const dist = resolve(root, 'dist');
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const entries = {
  'monitor-mcp': 'src/monitor-mcp.mjs',
  profile: 'src/profile.mjs',
  'hooks-runner': 'src/hooks/runner.mjs',
  'network-proxy': 'src/network-proxy.mjs',
  'network-watch': 'src/network-watch.mjs',
};

await build({
  entryPoints: Object.fromEntries(Object.entries(entries).map(([name, path]) => [name, resolve(root, path)])),
  outdir: dist,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  external: ['@ours.network/sdk', '@ours.network/sdk/*'],
  logLevel: 'info',
});
