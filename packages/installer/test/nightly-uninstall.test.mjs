import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planNightlyUninstall, runNightlyUninstaller } from '../lib/nightly-uninstall.mjs';
import { readRegistry, writeRegistry } from '../lib/profiles.mjs';

const profile = (id, ownership = { config: true, service: true, state: true }) => ({
  label: id, host: '127.0.0.1', port: id === 'default' ? 3050 : 3060,
  configPath: id === 'default' ? '/home/u/.ours/config.json' : `/home/u/.ours-${id}/config.json`,
  stateDir: id === 'default' ? '/home/u/.ours' : `/home/u/.ours-${id}`,
  serviceName: id === 'default' ? '' : id, ownership,
});
const registry = (profiles, harnessAssociations = {}) => ({ version: 1, profiles, harnessAssociations });

test('harness uninstall removes only its association and keeps shared package/profile', () => {
  const input = registry({ default: profile('default') }, { codex: 'default', hermes: 'default' });
  const plan = planNightlyUninstall(input, { removeHarnesses: ['codex'] });
  assert.deepEqual(plan.registry.harnessAssociations, { hermes: 'default' });
  assert.deepEqual(plan.removedAssociations, [{ application: 'codex', profileId: 'default' }]);
  assert.equal(plan.removeGlobalMcp, false);
  assert.deepEqual(plan.actions, []);
});

test('daemon removal and metadata forgetting refuse while any harness, Telegram, or Rooms depends on profile', () => {
  const input = registry({ default: profile('default') }, { codex: 'default' });
  assert.throws(() => planNightlyUninstall(input, { profileId: 'default', removeDaemon: true }), /still required by: codex/);
  const withoutHarness = registry({ default: profile('default') });
  assert.throws(() => planNightlyUninstall(withoutHarness, { profileId: 'default', forgetProfile: true }, {
    telegramConfig: { daemonUrl: 'http://127.0.0.1:3050', daemonStateDir: '/home/u/.ours' },
  }), /still required by: telegram/);
  assert.throws(() => planNightlyUninstall(withoutHarness, { profileId: 'default', removeDaemon: true }, {
    roomsConfig: { daemon: { endpoint: 'http://localhost:3050', stateDir: '/home/u/.ours' } },
  }), /still required by: rooms/);
});

test('owned daemon removal uninstalls only its exact service; data deletion is a separate action', () => {
  const input = registry({ default: profile('default'), blue: profile('blue') });
  const keepData = planNightlyUninstall(input, { profileId: 'blue', removeDaemon: true });
  assert.deepEqual(keepData.actions.map((a) => a.type), ['uninstall-service']);
  assert.equal(keepData.actions[0].profile.serviceName, 'blue');
  assert.ok(keepData.registry.profiles.default);
  assert.equal(keepData.registry.profiles.blue, undefined);
  assert.equal(keepData.removeGlobalMcp, false, 'another profile retains the global package');

  const deleteData = planNightlyUninstall(registry({ blue: profile('blue') }), {
    profileId: 'blue', removeDaemon: true, deleteData: true,
  });
  assert.deepEqual(deleteData.actions.map((a) => a.type), ['uninstall-service', 'delete-state']);
  assert.equal(deleteData.actions[1].path, '/home/u/.ours-blue');
  assert.equal(deleteData.removeGlobalMcp, true);
});

test('external profile can only be forgotten as metadata and its external data is never deleted', () => {
  const external = profile('external', { config: false, service: false, state: false });
  const forgotten = planNightlyUninstall(registry({ external }), { profileId: 'external', forgetProfile: true });
  assert.deepEqual(forgotten.actions.map((a) => a.type), ['forget-metadata']);
  assert.deepEqual(forgotten.registry.profiles, {});
  const removed = planNightlyUninstall(registry({ external }), { profileId: 'external', removeDaemon: true });
  assert.deepEqual(removed.actions.map((a) => a.type), ['external-service-kept']);
  assert.throws(() => planNightlyUninstall(registry({ external }), {
    profileId: 'external', removeDaemon: true, deleteData: true,
  }), /state is external/);
});

test('data deletion without daemon removal is rejected', () => {
  assert.throws(() => planNightlyUninstall(registry({ default: profile('default') }), {
    profileId: 'default', deleteData: true,
  }), /requires selecting daemon removal/);
  assert.throws(() => planNightlyUninstall(registry({ default: profile('default') }), {
    profileId: 'default', forgetProfile: true, removeDaemon: true,
  }), /either metadata-only forgetting or daemon removal/);
});

test('runner uninstalls only the selected exact service and commits before global package removal', () => {
  const home = mkdtempSync(join(tmpdir(), 'ours-nightly-uninstall-'));
  const registryPath = join(home, '.ours', 'installer-profiles.json');
  const blue = profile('blue');
  writeRegistry(registryPath, registry({ blue }));
  const before = { ...process.env };
  Object.assign(process.env, {
    HOME: home,
    OURS_INSTALL_PROFILES: registryPath,
    OURS_UNINSTALL_PROFILE: 'blue',
    OURS_UNINSTALL_DAEMON: 'yes',
  });
  const calls = [];
  try {
    runNightlyUninstaller({
      ttyFd: null, write: () => {}, npm: 'npm', assumeYes: true, finish: () => {},
      run: (bin, args, options = {}) => { calls.push({ bin, args, options }); return { status: 0 }; },
    });
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
    Object.assign(process.env, before);
  }
  assert.deepEqual(readRegistry(registryPath).profiles, {});
  const service = calls.find((call) => call.bin === 'ours-mcp');
  assert.deepEqual(service.args, ['uninstall-service']);
  assert.deepEqual(service.options.env, {
    OURS_CONFIG: blue.configPath, OURS_PORT: '3060', OURS_STATE_DIR: blue.stateDir, OURS_SERVICE_NAME: 'blue',
  });
  assert.deepEqual(calls.at(-1).args, ['rm', '-g', '@ours.network/mcp']);
});

test('runner treats corrupt connector configuration as an uninstall dependency it cannot safely inspect', () => {
  const home = mkdtempSync(join(tmpdir(), 'ours-nightly-uninstall-corrupt-'));
  const registryPath = join(home, '.ours', 'installer-profiles.json');
  const tgPath = join(home, 'telegram.json');
  mkdirSync(join(home, '.ours'), { recursive: true });
  writeRegistry(registryPath, registry({ default: profile('default') }));
  writeFileSync(tgPath, '{broken');
  const before = { ...process.env };
  Object.assign(process.env, { HOME: home, OURS_INSTALL_PROFILES: registryPath, OURS_TG_CONFIG: tgPath });
  const calls = [];
  try {
    runNightlyUninstaller({
      ttyFd: null, write: () => {}, npm: 'npm', assumeYes: true, finish: () => {},
      run: (...args) => { calls.push(args); return { status: 0 }; },
    });
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
    Object.assign(process.env, before);
  }
  assert.deepEqual(calls, []);
  assert.ok(readRegistry(registryPath).profiles.default);
});
