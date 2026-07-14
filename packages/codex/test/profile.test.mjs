import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { parseOursArgs, resolveDaemonProfile } from '../src/profile.mjs';

test('ours port flag wins and is removed from Codex args', async () => {
  const calls = [];
  const profile = await resolveDaemonProfile({
    argv: ['--model', 'gpt-5', '--ours-port', '4050', '--full-auto'],
    env: { OURS_PORT: '3051', OURS_API_TOKEN: 'token' },
    readConfig: async () => ({ port: 3052 }),
    fetch: async (url, init = {}) => {
      calls.push([String(url), init.headers]);
      return String(url).endsWith('/info')
        ? Response.json({ name: 'ours', port: 4050, pid: 42, version: '0.9.1', protocol: 1, stateDir: '/tmp/state' })
        : Response.json({ identities: [] });
    },
  });
  assert.equal(profile.port, 4050);
  assert.equal(profile.source, '--ours-port');
  assert.equal(profile.token, 'token');
  assert.deepEqual(profile.codexArgs, ['--model', 'gpt-5', '--full-auto']);
  assert.deepEqual(calls[1][1], { 'x-ours-api-token': 'token' });
});

test('profile precedence is flag, env, explicit config, default config, built-in', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ours-profile-'));
  const explicit = join(dir, 'custom.json');
  await writeFile(explicit, JSON.stringify({ port: 4011, apiToken: 'cfg-token', apiVisibility: 'shared' }));
  const fetch = async (url) => String(url).endsWith('/info')
    ? Response.json({ name: 'ours', version: '0.9.1', protocol: 1, stateDir: dir })
    : Response.json({ identities: [] });

  assert.equal((await resolveDaemonProfile({ argv: [], env: { OURS_PORT: '4010' }, readConfig: async () => ({ port: 4012 }), fetch })).port, 4010);
  assert.equal((await resolveDaemonProfile({ argv: [], env: { OURS_CONFIG: explicit }, fetch })).port, 4011);
  assert.equal((await resolveDaemonProfile({ argv: [], env: {}, readConfig: async () => ({ port: 4012 }), fetch })).port, 4012);
  assert.equal((await resolveDaemonProfile({ argv: [], env: {}, readConfig: async () => ({}), fetch })).port, 3050);
});

test('rejects malformed flags, unreachable and incompatible daemons', async () => {
  assert.throws(() => parseOursArgs(['--ours-port', '0']), /valid TCP port/);
  assert.throws(() => parseOursArgs(['--ours-port']), /requires a value/);
  await assert.rejects(() => resolveDaemonProfile({ argv: [], env: {}, readConfig: async () => ({}), fetch: async () => { throw new Error('refused'); } }), /not reachable.*never starts/i);
  await assert.rejects(() => resolveDaemonProfile({ argv: [], env: {}, readConfig: async () => ({}), fetch: async () => Response.json({ name: 'other', protocol: 99 }) }), /incompatible/);
  await assert.rejects(() => resolveDaemonProfile({ argv: [], env: {}, readConfig: async () => ({}), fetch: async (url) => String(url).endsWith('/info') ? Response.json({ name: 'ours', protocol: 1, stateDir: '/tmp/x' }) : new Response('no', { status: 401 }) }), /authentication failed/);
});

