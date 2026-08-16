import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
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

test('registry association sits below explicit env/config and fails closed on config or daemon state drift', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ours-profile-registry-'));
  const stateDir = join(home, '.ours-blue');
  const configPath = join(stateDir, 'config.json');
  const registryPath = join(home, '.ours', 'installer-profiles.json');
  await mkdir(join(home, '.ours'), { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await writeFile(configPath, JSON.stringify({ port: 4060, stateDir, apiToken: 'selected-token' }));
  const registry = {
    version: 1,
    profiles: { blue: {
      label: 'Blue', host: 'localhost', port: 4060, configPath, stateDir, serviceName: 'blue',
      ownership: { config: true, service: true, state: true },
    } },
    harnessAssociations: { codex: 'blue' },
  };
  await writeFile(registryPath, JSON.stringify(registry));
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push([String(url), init.headers]);
    return String(url).endsWith('/info')
      ? Response.json({ name: 'ours', version: '1', protocol: 1, stateDir })
      : Response.json({ identities: [] });
  };
  const selected = await resolveDaemonProfile({ argv: [], env: { HOME: home }, fetch });
  assert.equal(selected.port, 4060);
  assert.equal(selected.source, 'registry');
  assert.equal(selected.profileId, 'blue');
  assert.equal(selected.configPath, configPath);
  assert.deepEqual(calls[1][1], { 'x-ours-api-token': 'selected-token' });

  const explicit = await resolveDaemonProfile({
    argv: [], env: { HOME: home, OURS_PORT: '4070' }, readConfig: async () => ({}),
    fetch: async (url) => String(url).endsWith('/info')
      ? Response.json({ name: 'ours', protocol: 1, stateDir: '/explicit' })
      : Response.json({ identities: [] }),
  });
  assert.equal(explicit.port, 4070, 'explicit port bypasses registry');

  await writeFile(configPath, JSON.stringify({ port: 4061, stateDir }));
  await assert.rejects(() => resolveDaemonProfile({ argv: [], env: { HOME: home }, fetch }), /disagrees.*port\/stateDir.*Nightly installer/);
  const malformed = structuredClone(registry);
  malformed.profiles.unused = { ...malformed.profiles.blue, label: 'Unused', apiToken: 'must-not-be-here' };
  await writeFile(registryPath, JSON.stringify(malformed));
  await assert.rejects(() => resolveDaemonProfile({ argv: [], env: { HOME: home }, fetch }), /unsupported field.*Nightly installer/);
  await writeFile(registryPath, JSON.stringify(registry));
  await writeFile(configPath, JSON.stringify({ port: 4060, stateDir, apiToken: 'never-print-me' }));
  await assert.rejects(() => resolveDaemonProfile({
    argv: [], env: { HOME: home },
    fetch: async (url) => String(url).endsWith('/info')
      ? Response.json({ name: 'ours', protocol: 1, stateDir: join(home, '.wrong') })
      : Response.json({ identities: [] }),
  }), (error) => /expects stateDir.*Nightly installer/.test(error.message) && !error.message.includes('never-print-me'));
});

test('rejects malformed flags, unreachable and incompatible daemons', async () => {
  assert.throws(() => parseOursArgs(['--ours-port', '0']), /valid TCP port/);
  assert.throws(() => parseOursArgs(['--ours-port']), /requires a value/);
  await assert.rejects(() => resolveDaemonProfile({ argv: [], env: {}, readConfig: async () => ({}), fetch: async () => { throw new Error('refused'); } }), /not reachable.*never starts/i);
  await assert.rejects(() => resolveDaemonProfile({ argv: [], env: {}, readConfig: async () => ({}), fetch: async () => Response.json({ name: 'other', protocol: 99 }) }), /incompatible/);
  await assert.rejects(() => resolveDaemonProfile({ argv: [], env: {}, readConfig: async () => ({}), fetch: async (url) => String(url).endsWith('/info') ? Response.json({ name: 'ours', protocol: 1, stateDir: '/tmp/x' }) : new Response('no', { status: 401 }) }), /authentication failed/);
  await assert.rejects(() => resolveDaemonProfile({ argv: [], env: {}, readConfig: async () => ({}), fetch: async (url) => {
    if (String(url).endsWith('/info')) return Response.json({ name: 'ours', protocol: 1, stateDir: '/tmp/x' });
    if (String(url).endsWith('/identities')) return Response.json({ identities: [] });
    return new Response('missing', { status: 404 });
  } }), /unread API/);
  await assert.rejects(() => resolveDaemonProfile({ argv: [], env: {}, readConfig: async () => ({}), fetch: async (url) => {
    if (String(url).endsWith('/info')) return Response.json({ name: 'ours', protocol: 1, stateDir: '/tmp/x' });
    if (String(url).endsWith('/identities')) return Response.json({ identities: [] });
    throw new Error('daemon vanished');
  } }), /unread capability check failed.*daemon vanished/);
});
