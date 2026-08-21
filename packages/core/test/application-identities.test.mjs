import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ApplicationIdentityStore, filterApplicationIdentities } from '../dist/application-identities.js';

const root = mkdtempSync(join(tmpdir(), 'ours-mcp-identities-'));
const path = join(root, 'nested', 'config.json');
const alpha = new ApplicationIdentityStore(join(root, 'daemon-a'), { path });
const beta = new ApplicationIdentityStore(join(root, 'daemon-b'), { path });

assert.deepEqual(await alpha.list(), [], 'a fresh install does not seed daemon-global identities');
await alpha.add('Zed');
await alpha.add('Alice');
await alpha.add('Alice');
await beta.add('Bob');
assert.deepEqual(await alpha.list(), ['Alice', 'Zed']);
assert.deepEqual(await beta.list(), ['Bob'], 'identity lists are scoped by selected daemon state directory');
assert.deepEqual(
  await filterApplicationIdentities(alpha, [{ name: 'daemon-only' }, { name: 'Zed' }]),
  [{ name: 'Zed' }],
  'daemon-global enumerations expose only application identities',
);

await alpha.remove('missing');
await alpha.remove('Alice');
assert.deepEqual(await alpha.list(), ['Zed'], 'remove is idempotent and preserves other names');
assert.equal(statSync(path).mode & 0o777, 0o600, 'application config is private');
assert.doesNotMatch(readFileSync(path, 'utf8'), /\.tmp/, 'the committed file is complete JSON, not a temp path');

writeFileSync(path, JSON.stringify({ version: 2, daemons: {} }));
await assert.rejects(alpha.list(), /Unsupported ours-mcp application identity config version/);
chmodSync(path, 0o600);

console.log('application-identities: all passed');
