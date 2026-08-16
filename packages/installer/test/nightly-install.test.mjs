import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runNightlyInstaller } from '../lib/nightly-install.mjs';
import { profilesPath, readRegistry, writeRegistry } from '../lib/profiles.mjs';

const makeDeps = ({ run, runAsync, ask, yes, fetch, probe } = {}) => {
  const calls = [];
  const runImpl = (bin, args, options) => {
    calls.push({ kind: 'run', bin, args, options });
    return run ? run(bin, args, options) : { ok: true, code: 0, out: '', err: '' };
  };
  const asyncImpl = async (bin, args) => {
    calls.push({ kind: 'async', bin, args });
    return runAsync ? runAsync(bin, args) : { ok: true, code: 0, out: '', err: '' };
  };
  return {
    deps: {
      harnesses: [
        { name: 'claude', status: 'ok' }, { name: 'codex', status: 'ok' }, { name: 'hermes', status: 'ok' },
      ],
      ttyFd: null, interactive: false, write: () => {}, cont: () => {}, dry: false,
      npm: 'npm', run: runImpl, runAsync: asyncImpl,
      act: async (_desc, fn) => fn(), actSpin: async (_label, _desc, fn) => fn(),
      finish: () => {}, ask: ask || ((_prompt, def) => def), yes: yes || ((_prompt, def) => def),
      fetch, probe,
    },
    calls,
  };
};

async function withHome(fn) {
  const before = { HOME: process.env.HOME, assume: process.env.OURS_ASSUME_YES, registry: process.env.OURS_INSTALL_PROFILES };
  const home = mkdtempSync(join(tmpdir(), 'ours-nightly-install-'));
  process.env.HOME = home;
  process.env.OURS_INSTALL_PROFILES = join(home, '.ours', 'installer-profiles.json');
  try { return await fn(home); }
  finally {
    if (before.HOME === undefined) delete process.env.HOME; else process.env.HOME = before.HOME;
    if (before.assume === undefined) delete process.env.OURS_ASSUME_YES; else process.env.OURS_ASSUME_YES = before.assume;
    if (before.registry === undefined) delete process.env.OURS_INSTALL_PROFILES; else process.env.OURS_INSTALL_PROFILES = before.registry;
  }
}

test('assume-yes default-creates historical topology, associates detected harnesses, and updates global mcp once', async () => withHome(async (home) => {
  process.env.OURS_ASSUME_YES = '1';
  const stateDir = join(home, '.ours');
  let started = false;
  const { deps, calls } = makeDeps({
    run: (bin, args) => {
      if (bin === 'ours-mcp' && args[0] === 'start') started = true;
      return { ok: true, code: 0, out: '', err: '' };
    },
    fetch: async (url) => {
      if (String(url).endsWith('/info')) {
        if (!started) throw new Error('not listening yet');
        return Response.json({ name: 'ours', stateDir });
      }
      if (String(url).endsWith('/version')) return Response.json({ version: '0.16.0-nightly' });
      return Response.json({ identities: [] });
    },
  });
  await runNightlyInstaller(deps);
  const registry = readRegistry(profilesPath(process.env, home));
  assert.deepEqual(registry.harnessAssociations, { 'claude-code': 'default', codex: 'default', hermes: 'default' });
  assert.equal(registry.profiles.default.port, 3050);
  assert.deepEqual(registry.profiles.default.ownership, { config: true, service: true, state: true });
  assert.equal(statSync(profilesPath(process.env, home)).mode & 0o777, 0o600);
  assert.equal(calls.filter((call) => call.kind === 'async' && call.args.includes('@ours.network/mcp@nightly')).length, 1);
  assert.equal(calls.some((call) => call.args?.includes('@ours.network/tg-connector@nightly')), false);
  assert.equal(calls.some((call) => call.args?.includes('@ours.network/cowork@nightly')), false);
  const service = calls.find((call) => call.bin === 'ours-mcp' && call.args[0] === 'install-service');
  assert.equal(service.options.env.OURS_CONFIG, join(stateDir, 'config.json'));
  assert.equal(service.options.env.OURS_STATE_DIR, stateDir);
}));

test('idempotent rerun keeps the association and does not update/restart the existing profile', async () => withHome(async (home) => {
  process.env.OURS_ASSUME_YES = '1';
  const stateDir = join(home, '.ours');
  const configPath = join(stateDir, 'config.json');
  const registryPath = profilesPath(process.env, home);
  writeRegistry(registryPath, {
    version: 1,
    profiles: { default: {
      label: 'Default ours daemon', host: '127.0.0.1', port: 3050, configPath, stateDir, serviceName: '',
      ownership: { config: true, service: true, state: true },
    } },
    harnessAssociations: { codex: 'default' },
  });
  writeFileSync(configPath, JSON.stringify({ port: 3050, stateDir, autoStart: false }) + '\n', { mode: 0o600 });
  let protectedChecks = 0;
  const { deps, calls } = makeDeps({
    probe: async (candidate) => ({ ...candidate, reachable: true, compatible: true }),
    fetch: async (url) => {
      if (String(url).endsWith('/info')) return Response.json({ name: 'ours', stateDir });
      if (String(url).endsWith('/version')) return Response.json({ version: '0.16.0-nightly' });
      protectedChecks += 1;
      return Response.json({ identities: [] });
    },
  });
  await runNightlyInstaller(deps);
  assert.equal(protectedChecks, 1, 'rerun reaches protected verification instead of exiting during candidate normalization');
  assert.equal(calls.some((call) => call.kind === 'async' && call.args.includes('@ours.network/mcp@nightly')), false);
  assert.equal(calls.some((call) => call.bin === 'ours-mcp' && call.args[0] === 'restart'), false);
  assert.equal(readRegistry(registryPath).harnessAssociations.codex, 'default');
}));

test('new-profile service failure keeps recoverable daemon config/state but never commits app/registry bytes', async () => withHome(async (home) => {
  process.env.OURS_ASSUME_YES = '1';
  const stateDir = join(home, '.ours');
  const configPath = join(stateDir, 'config.json');
  let starts = 0;
  const { deps } = makeDeps({
    fetch: async () => { throw new Error('not listening yet'); },
    run: (bin, args) => {
      if (bin === 'ours-mcp' && args[0] === 'start') { starts += 1; return { ok: true, code: 0 }; }
      if (bin === 'ours-mcp' && args[0] === 'install-service') return { ok: false, code: 1 };
      return { ok: true, code: 0, out: '', err: '' };
    },
  });
  await runNightlyInstaller(deps);
  assert.equal(starts, 2, 'one start plus service-failure recovery');
  assert.equal(existsSync(configPath), true, 'new daemon config is retained for recovered partial state');
  assert.equal(existsSync(profilesPath(process.env, home)), false, 'registry never committed');
  assert.equal(existsSync(stateDir), true, 'new state directory is retained after partial failure');
}));

test('Telegram config is written before service snapshot/apply and rolls back on apply failure', async () => withHome(async (home) => {
  const stateDir = join(home, '.ours');
  const configPath = join(stateDir, 'config.json');
  const registryPath = profilesPath(process.env, home);
  writeRegistry(registryPath, {
    version: 1,
    profiles: { default: {
      label: 'Default ours daemon', host: '127.0.0.1', port: 3050, configPath, stateDir, serviceName: '',
      ownership: { config: false, service: false, state: false },
    } }, harnessAssociations: {},
  });
  writeFileSync(configPath, JSON.stringify({ port: 3050, stateDir }) + '\n');
  const tgPath = join(home, '.ours-telegram', 'config.json');
  const original = JSON.stringify({ botToken: 'preserved', daemonUrl: 'http://127.0.0.1:3099' }) + '\n';
  mkdirSync(join(home, '.ours-telegram'), { recursive: true });
  writeFileSync(tgPath, original, { mode: 0o600 });
  const yes = (prompt, def) => {
    if (prompt.includes('ours-fleet')) return false;
    if (prompt.includes('Point Telegram')) return true;
    if (prompt.includes('Point Rooms')) return false;
    if (prompt.includes('Use profile')) return false;
    return def;
  };
  const { deps } = makeDeps({
    ask: (prompt, def) => prompt.includes('Choose profile') ? '1' : def,
    yes,
    probe: async (candidate) => ({ ...candidate, reachable: true, compatible: true }),
    fetch: async (url) => {
      if (String(url).endsWith('/info')) return Response.json({ name: 'ours', stateDir });
      if (String(url).endsWith('/version')) return Response.json({ version: '0.16.0-nightly' });
      return Response.json({ identities: [] });
    },
    run: (bin, args) => {
      if (bin === 'ours-tg-connector' && args[0] === 'install-service') {
        const duringApply = JSON.parse(readFileSync(tgPath, 'utf8'));
        assert.equal(duringApply.daemonUrl, 'http://127.0.0.1:3050');
        assert.equal(duringApply.botToken, 'preserved');
        return { ok: false, code: 1 };
      }
      return { ok: true, code: 0, out: '', err: '' };
    },
  });
  await runNightlyInstaller(deps);
  assert.equal(readFileSync(tgPath, 'utf8'), original, 'connector config restored byte-for-byte');
  assert.deepEqual(readRegistry(registryPath).harnessAssociations, {}, 'registry remains unchanged');
}));
