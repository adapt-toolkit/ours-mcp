import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
assert.equal(pkg.dependencies['@ours.network/sdk'], '3.2.0', 'SDK must stay exactly pinned');
assert.equal(pkg.dependencies['@ours.network/cli'], '2.2.0', 'CLI must stay exactly pinned');

const require = createRequire(import.meta.url);
function packageRoot(entry, expectedName) {
  let current = dirname(require.resolve(entry));
  for (let depth = 0; depth < 8; depth += 1) {
    const manifest = join(current, 'package.json');
    if (existsSync(manifest)) {
      const value = JSON.parse(readFileSync(manifest, 'utf8'));
      if (value.name === expectedName) return { current, value };
    }
    current = dirname(current);
  }
  throw new Error(`Cannot locate ${expectedName}`);
}

const sdk = packageRoot('@ours.network/sdk', '@ours.network/sdk');
assert.equal(sdk.value.version, '3.2.0');
assert.equal(lstatSync(sdk.current).isSymbolicLink(), false, 'SDK must be a registry artifact, not a link');

const cliPath = require.resolve('@ours.network/cli/package.json');
const cli = JSON.parse(readFileSync(cliPath, 'utf8'));
assert.equal(cli.version, '2.2.0');
assert.equal(lstatSync(dirname(cliPath)).isSymbolicLink(), false, 'CLI must be a registry artifact, not a link');

const lock = JSON.parse(readFileSync(new URL('../../../package-lock.json', import.meta.url), 'utf8'));
for (const [path, version] of [
  ['node_modules/@ours.network/sdk', '3.2.0'],
  ['node_modules/@ours.network/cli', '2.2.0'],
]) {
  const entry = lock.packages[path];
  assert.equal(entry.version, version);
  assert.match(entry.resolved, /^https:\/\/registry\.npmjs\.org\//);
}

for (const file of ['src', 'build.mjs']) {
  const path = new URL(`../${file}`, import.meta.url);
  const text = file === 'src'
    ? readFileSync(new URL('../src/connector.ts', import.meta.url), 'utf8') + readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8')
    : readFileSync(path, 'utf8');
  assert.doesNotMatch(text, /@ours\.network\/sdk\/daemon/);
}

console.log('sdk-pin: SDK 3.2.0 and CLI 2.2.0 registry pins verified');
