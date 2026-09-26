import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hostProfileFromEnv, readHostProfile, validateHostProfile } from '../dist/host-profile.js';

const root = mkdtempSync(join(tmpdir(), 'ours-mcp-host-profile-'));
const profile = join(root, 'profile.json');
const tuple = {
  serverUrl: 'http://127.0.0.1:8787', endpoint: 'http://127.0.0.1:8787/daemon',
  expectedInstanceId: '6d1e0b1a-cba2-4d33-9389-7d1787ea325f',
  credentialPath: join(root, 'credential'),
};
writeFileSync(profile, `${JSON.stringify(tuple)}\n`, { mode: 0o600 });
assert.deepEqual(readHostProfile(profile), { ...tuple, endpoint: 'http://127.0.0.1:8787/daemon' }, 'complete tuple is selected and normalized');

const empty = join(root, 'empty.json');
writeFileSync(empty, '{}\n', { mode: 0o600 });
assert.throws(() => readHostProfile(empty), /gateway client profile/i, 'empty profile cannot select local mode');

const partial = join(root, 'partial.json');
writeFileSync(partial, JSON.stringify({ endpoint: tuple.endpoint }), { mode: 0o600 });
assert.throws(() => readHostProfile(partial), /gateway client profile/i, 'partial file tuple cannot fall through');
assert.throws(() => validateHostProfile({ endpoint: tuple.endpoint }), /gateway client profile/i, 'partial programmatic tuple is rejected');

const mixed = join(root, 'mixed.json');
writeFileSync(mixed, JSON.stringify({ ...tuple, port: 1234 }), { mode: 0o600 });
assert.throws(() => readHostProfile(mixed), /daemon-local configuration/i, 'legacy selectors cannot mix with profile');

chmodSync(profile, 0o644);
assert.throws(() => readHostProfile(profile), /unsafe|0600/i, 'group-readable profile is rejected');
chmodSync(profile, 0o600);

assert.deepEqual(hostProfileFromEnv({ OURS_CONFIG: profile }), { ...tuple, endpoint: 'http://127.0.0.1:8787/daemon' }, 'explicit config selects profile');
assert.throws(() => hostProfileFromEnv({ OURS_CONFIG: join(root, 'absent.json') }), /missing|unsafe/i, 'unreadable explicit config refuses');
assert.throws(() => hostProfileFromEnv({ OURS_CONFIG: profile, OURS_API_TOKEN: 'legacy' }), /legacy/i, 'legacy credentials conflict with profile');
console.log('host-profile: all passed');

const { spawnSync } = await import('node:child_process');
for (const command of ['watch']) {
  const result = spawnSync('node', [new URL('../dist/cli.js', import.meta.url).pathname, command], {
    env: { ...process.env, OURS_CONFIG: profile, OURS_API_TOKEN: undefined, OURS_PORT: undefined, OURS_STATE_DIR: undefined, OURS_DAEMON_ID: undefined },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0, `${command} rejects host profiles without an immutable owner context`);
  assert.match(result.stderr, /Native session metadata is missing or invalid/, `${command} refuses before legacy attachment`);
}
const emptyEnd = spawnSync('node', [new URL('../dist/cli.js', import.meta.url).pathname, 'session-end'], {
  env: { ...process.env, OURS_CONFIG: profile, OURS_MCP_CONFIG: join(root, 'mcp.json'), OURS_API_TOKEN: undefined, OURS_PORT: undefined, OURS_STATE_DIR: undefined, OURS_DAEMON_ID: undefined },
  input: JSON.stringify({ session_id: 'never-attached' }),
  encoding: 'utf8',
});
assert.equal(emptyEnd.status, 0, emptyEnd.stderr);
console.log('host-profile CLI refusals: passed');

const { mkdirSync } = await import('node:fs');
const defaultHome = join(root, 'default-home');
const defaultConfigDir = join(defaultHome, '.ours-client');
mkdirSync(defaultConfigDir, { recursive: true, mode: 0o700 });
const defaultProfile = join(defaultConfigDir, 'profile.json');
writeFileSync(defaultProfile, JSON.stringify({ ...tuple, credentialPath: join(root, 'missing-default-credential') }), { mode: 0o600 });
const cli = new URL('../dist/cli.js', import.meta.url).pathname;
const bareEnv = { ...process.env, HOME: defaultHome };
for (const key of ['OURS_CONFIG', 'OURS_API_TOKEN', 'OURS_PORT', 'OURS_STATE_DIR', 'OURS_DAEMON_ID']) delete bareEnv[key];
const defaultWatch = spawnSync('node', [cli, 'watch'], { env: bareEnv, encoding: 'utf8' });
assert.notEqual(defaultWatch.status, 0); assert.match(defaultWatch.stderr, /Native session metadata is missing or invalid/);
const defaultEnd = spawnSync('node', [cli, 'session-end'], { env: { ...bareEnv, OURS_MCP_CONFIG: join(root, 'default-mcp.json') }, input: JSON.stringify({ session_id: 'never-attached' }), encoding: 'utf8' });
assert.equal(defaultEnd.status, 0, defaultEnd.stderr);
const defaultProxy = spawnSync('node', [cli, 'proxy'], { env: bareEnv, encoding: 'utf8' });
assert.equal(defaultProxy.status, 0, defaultProxy.stderr);
assert.match(defaultProxy.stderr, /MCP server .* ready/, 'default profile starts lazily before credential access');
const explicitProxy = spawnSync('node', [cli, 'proxy'], { env: { ...bareEnv, OURS_CONFIG: profile }, encoding: 'utf8' });
assert.equal(explicitProxy.status, 0, explicitProxy.stderr);
assert.match(explicitProxy.stderr, /MCP server .* ready/, 'explicit profile starts lazily before credential access');
console.log('host-profile lazy proxy startup: passed');

const partialSelection = spawnSync('node', [
  '--input-type=module',
  '-e',
  `import { runConnector } from ${JSON.stringify(new URL('../dist/connector.js', import.meta.url).pathname)}; await runConnector({ leaseToken: 'legacy', clientPid: 2, version: 'test', selection: { mode: 'external-profile', profile: { endpoint: 'http://127.0.0.1:1' }, ownerInstanceId: 'fixture' } });`,
], { env: bareEnv, input: '', encoding: 'utf8' });
assert.match(partialSelection.stderr, /gateway client profile/i, 'partial programmatic external selection refuses before legacy attachment');
assert.doesNotMatch(partialSelection.stderr, /127\.0\.0\.1:3050|no ours daemon/i, 'partial programmatic external selection never falls through to default daemon resolution');
console.log('host-profile programmatic selection refusal: passed');

// Managed client selection is authoritative even when a legacy daemon config exists.
const managedDir = join(defaultHome, '.ours-client');
mkdirSync(managedDir, { recursive: true, mode: 0o700 });
const managedPath = join(managedDir, 'profile.json');
const managedTuple = { ...tuple, serverUrl: 'http://127.0.0.1:9876', endpoint: 'http://127.0.0.1:9876/daemon' };
writeFileSync(managedPath, JSON.stringify(managedTuple), { mode: 0o600 });
assert.deepEqual(hostProfileFromEnv({ HOME: defaultHome }), managedTuple);
assert.deepEqual(hostProfileFromEnv({ HOME: defaultHome, OURS_CONFIG: profile }), { ...tuple, endpoint: 'http://127.0.0.1:8787/daemon' });
for (const invalid of ['{}', '{broken', JSON.stringify({ composeFile: '/not-a-fallback' })]) {
  writeFileSync(managedPath, invalid);
  assert.throws(() => hostProfileFromEnv({ HOME: defaultHome }), /gateway client profile/i);
}
writeFileSync(managedPath, JSON.stringify(managedTuple));
chmodSync(managedPath, 0);
assert.throws(() => hostProfileFromEnv({ HOME: defaultHome }), /missing|unsafe/i);
chmodSync(managedPath, 0o600);
chmodSync(managedDir, 0);
assert.throws(() => hostProfileFromEnv({ HOME: defaultHome }), /missing|unsafe/i);
chmodSync(managedDir, 0o700);
console.log('managed client selection: passed');

const secureTuple = { ...tuple, serverUrl: 'https://server.example:8443/', endpoint: 'https://server.example:8443/daemon' };
assert.deepEqual(validateHostProfile(secureTuple), { ...secureTuple, serverUrl: 'https://server.example:8443' });
for (const [endpoint, expected] of [
  ['http://127.0.0.1:3050/daemon', 'http://127.0.0.1:3050/daemon'],
  ['https://server.example/base/daemon///', 'https://server.example/base/daemon'],
]) {
  assert.deepEqual(validateHostProfile({ ...tuple, serverUrl: expected.replace(/\/daemon$/, ''), endpoint }), { ...tuple, serverUrl: expected.replace(/\/daemon$/, ''), endpoint: expected }, 'gateway prefix survives profile validation');
}
for (const endpoint of ['ftp://server.example', 'wss://server.example', 'https://user:pass@server.example', 'https://server.example?q=1', 'https://server.example#fragment', 'https://server.example/bad path', 'https://server.example/\\\\daemon']) {
  assert.throws(() => validateHostProfile({ ...tuple, endpoint }));
}
console.log('HTTPS profile validation: passed');
