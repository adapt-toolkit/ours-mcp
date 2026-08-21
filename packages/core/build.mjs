import { readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const root = dirname(fileURLToPath(import.meta.url));
const dist = resolve(root, 'dist');
const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
const minify = process.env.OURS_BUILD_DEV !== '1';

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  minify,
  define: { __OURS_VERSION__: JSON.stringify(version) },
  external: ['@ours.network/sdk', '@ours.network/sdk/*'],
  logLevel: 'info',
};

for (const entry of ['cli', 'connector', 'application-identities', 'contacts', 'mcp/push']) {
  await build({
    ...shared,
    entryPoints: [resolve(root, `src/${entry}.ts`)],
    outfile: resolve(dist, `${entry.split('/').at(-1)}.js`),
  });
}
