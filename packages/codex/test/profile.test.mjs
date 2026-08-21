import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { parseOursArgs, resolveDaemonProfile } from '../src/profile.mjs';

const daemonFetch = (stateDir, calls = []) => async (url, init = {}) => {
  calls.push([String(url), init.headers]);
  if (String(url).endsWith('/state-dir')) return Response.json({ stateDir, version: '2.0.1', compat: 1 });
  if (String(url).endsWith('/info')) return Response.json({ name: 'ours', version: '2.0.1', protocol: 1, stateDir });
  return Response.json({ identities: [] });
};

test('ours port flag is removed from Codex args and requires coherent state selection', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'ours-codex-state-'));
  const profile = await resolveDaemonProfile({
    argv: ['--model', 'gpt-5', '--ours-port', '4050', '--full-auto'],
    env: { OURS_STATE_DIR: stateDir, OURS_API_TOKEN: 'token' },
    fetch: daemonFetch(stateDir),
  });
  assert.equal(profile.port, 4050);
  assert.equal(profile.token, 'token');
  assert.deepEqual(profile.codexArgs, ['--model', 'gpt-5', '--full-auto']);

  await assert.rejects(
    resolveDaemonProfile({ argv: ['--ours-port', '4050'], env: {}, fetch: daemonFetch(stateDir) }),
    /state directory/i,
  );
});

test('explicit config selects and verifies one shared daemon without associations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ours-codex-config-'));
  const stateDir = join(root, 'state');
  const configPath = join(root, 'config.json');
  await writeFile(configPath, JSON.stringify({ port: 4060, stateDir, apiToken: 'selected-token' }));
  const calls = [];
  const profile = await resolveDaemonProfile({
    env: { OURS_CONFIG: configPath },
    fetch: daemonFetch(stateDir, calls),
  });
  assert.equal(profile.port, 4060);
  assert.equal(profile.stateDir, stateDir);
  assert.equal(profile.configPath, configPath);
  assert.equal(profile.token, 'selected-token');
  assert.deepEqual(calls.at(-1)[1], { 'x-ours-api-token': 'selected-token' });
});

test('selection and capability failures stay loud', async () => {
  assert.throws(() => parseOursArgs(['--ours-port', '0']), /valid TCP port/);
  assert.throws(() => parseOursArgs(['--ours-port']), /requires a value/);
  const stateDir = await mkdtemp(join(tmpdir(), 'ours-codex-fail-'));
  await assert.rejects(
    resolveDaemonProfile({ env: { OURS_STATE_DIR: stateDir }, fetch: async () => { throw new Error('refused'); } }),
    /not available|no ours daemon|refused/i,
  );
  await assert.rejects(
    resolveDaemonProfile({
      env: { OURS_STATE_DIR: stateDir },
      fetch: async (url) => String(url).endsWith('/state-dir')
        ? Response.json({ stateDir, version: '2.0.1', compat: 1 })
        : String(url).endsWith('/info')
          ? Response.json({ name: 'ours', protocol: 1, stateDir })
          : new Response('no', { status: 401 }),
    }),
    /authentication failed/,
  );
});
