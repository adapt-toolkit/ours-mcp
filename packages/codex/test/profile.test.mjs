import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { launcherEnvironment } from '../src/launcher.mjs';
import { parseOursArgs, resolveDaemonProfile } from '../dist/profile.mjs';

const daemonFetch = (stateDir, calls = []) => async (url, init = {}) => {
  calls.push([String(url), init.headers]);
  if (String(url).endsWith('/state-dir')) return Response.json({ stateDir, version: '2.0.1', compat: 1 });
  if (String(url).endsWith('/info')) return Response.json({ name: 'ours', version: '2.0.1', protocol: 1, stateDir });
  return Response.json({ identities: [] });
};

test('legacy selection and direct port flags never attach or consult local state', async () => {
  assert.throws(() => parseOursArgs(['--ours-port', '0']), /valid TCP port/);
  assert.throws(() => parseOursArgs(['--ours-port']), /requires a value/);
  const root = await mkdtemp(join(tmpdir(), 'ours-codex-legacy-'));
  const path = join(root, 'config.json');
  await writeFile(path, JSON.stringify({ port: 4060, stateDir: root, apiToken: 'private' }), { mode: 0o600 });
  for (const env of [{ HOME: root }, { OURS_CONFIG: path }, { HOME: root, OURS_PORT: '4050' }]) {
    await assert.rejects(resolveDaemonProfile({ env, attach: async () => assert.fail('must not attach'), fetch: async () => assert.fail('must not fetch') }), /gateway client profile/);
  }
});

test('host profile is validated through a credential-backed SDK attachment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ours-codex-host-profile-'));
  const configPath = join(root, 'profile.json');
  const credentialPath = join(root, 'token');
  const expectedInstanceId = '12345678-1234-1234-1234-123456789abc';
  await writeFile(configPath, JSON.stringify({ serverUrl: 'http://127.0.0.1:4567', endpoint: 'http://127.0.0.1:4567/daemon', expectedInstanceId, credentialPath }), { mode: 0o600 });
  const attachments = [];
  let closed = false;
  const profile = await resolveDaemonProfile({
    argv: ['--model', 'gpt-5'], env: { OURS_CONFIG: configPath },
    attach: async (options) => {
      attachments.push(options);
      return {
        version: async () => ({ name: 'ours', version: '3.0.0', protocol: 1, compat: 1 }),
        identities: async () => [], unread: async () => ({ identities: [] }),
        close: async () => { closed = true; },
      };
    },
  });
  assert.deepEqual(attachments[0], {
    serverUrl: 'http://127.0.0.1:4567', endpoint: 'http://127.0.0.1:4567/daemon', expectedInstanceId, credentialPath,
    sessionMode: 'external', leaseToken: attachments[0].leaseToken, env: {},
  });
  assert.ok(attachments[0].leaseToken);
  assert.equal(closed, true);
  assert.equal(profile.profile.expectedInstanceId, expectedInstanceId);
  assert.equal(profile.baseUrl, 'http://127.0.0.1:4567/daemon');
  assert.equal(profile.configPath, configPath);
  assert.deepEqual(profile.codexArgs, ['--model', 'gpt-5']);
  assert.equal('token' in profile, false);
  assert.equal('stateDir' in profile, false);
});

test('host profile refuses --ours-port before any daemon attachment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ours-codex-host-conflict-'));
  const configPath = join(root, 'profile.json');
  await writeFile(configPath, JSON.stringify({ serverUrl: 'http://127.0.0.1:4567', endpoint: 'http://127.0.0.1:4567/daemon', expectedInstanceId: '12345678-1234-1234-1234-123456789abc', credentialPath: join(root, 'token') }), { mode: 0o600 });
  await assert.rejects(resolveDaemonProfile({ argv: ['--ours-port', '4050'], env: { OURS_CONFIG: configPath }, attach: async () => assert.fail('must not attach') }), /conflicts.*host-profile/i);
});

test('managed selection propagates its actual path to native launch configuration', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ours-codex-managed-'));
  const configPath = join(home, '.ours-client', 'profile.json');
  await mkdir(join(home, '.ours-client'), { mode: 0o700 });
  await writeFile(configPath, JSON.stringify({ serverUrl: 'http://127.0.0.1:4567', endpoint: 'http://127.0.0.1:4567/daemon', expectedInstanceId: '12345678-1234-1234-1234-123456789abc', credentialPath: join(home, 'token') }), { mode: 0o600 });
  const selected = await resolveDaemonProfile({ env: { HOME: home },
    fetch: async () => assert.fail('must not select legacy daemon'),
    attach: async () => ({ version: async () => ({}), identities: async () => [], unread: async () => ({}), close: async () => {} }),
  });
  assert.equal(selected.configPath, configPath);
  assert.equal(launcherEnvironment({ HOME: home }, selected, { socketPath: '/tmp/control', capability: 'test' }).OURS_CONFIG, configPath);
  assert.equal(selected.profile.endpoint, 'http://127.0.0.1:4567/daemon');
});
