import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runNightlyInstaller } from '../lib/nightly-install.mjs';
import { profilesPath, readRegistry, writeRegistry } from '../lib/profiles.mjs';
import { COWORK_EXTERNAL_MIN_VERSION } from '../lib/logic.mjs';

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

const xmlText = (value) => String(value).replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
})[character]);

function namedPlist({ id, configPath, port, stateDir }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>EnvironmentVariables</key>
  <dict>
    <key>OURS_PORT</key><string>${port}</string>
    <key>OURS_STATE_DIR</key><string>${xmlText(stateDir)}</string>
    <key>OURS_CONFIG</key><string>${xmlText(configPath)}</string>
    <key>OURS_SERVICE_NAME</key><string>${id}</string>
  </dict>
</dict>
</plist>
`;
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

test('manual existing selection refuses a client config that resolves a different daemon profile', async () => withHome(async (home) => {
  const selectedState = join(home, '.ours-selected');
  const configPath = join(home, 'client', 'config.json');
  mkdirSync(join(home, 'client'), { recursive: true });
  writeFileSync(configPath, JSON.stringify({
    port: 3099,
    stateDir: join(home, '.ours-other'),
  }) + '\n', { mode: 0o600 });
  const answers = new Map([
    ['Choose profile', 'm'],
    ['Profile id', 'selected'],
    ['Profile label', 'Selected existing daemon'],
    ['Host', '127.0.0.1'],
    ['Port', '3060'],
    ['Exact state directory', selectedState],
    ['Existing/client config path', configPath],
    ['Service instance name', 'selected'],
  ]);
  const { deps, calls } = makeDeps({
    ask: (prompt, def) => [...answers].find(([key]) => prompt.includes(key))?.[1] ?? def,
    probe: async (candidate) => ({ ...candidate, reachable: true, compatible: true }),
    fetch: async (url) => String(url).endsWith('/info')
      ? Response.json({ name: 'ours', stateDir: selectedState })
      : String(url).endsWith('/version')
        ? Response.json({ version: '0.16.0-nightly' })
        : Response.json({ identities: [] }),
  });
  await runNightlyInstaller(deps);
  assert.equal(existsSync(profilesPath(process.env, home)), false, 'a drifted client config is never associated');
  assert.equal(calls.length, 0, 'no package, harness, service, or identity mutation starts after config drift');
}));

test('manual existing selection applies runtime config types and defaults before any mutation', async () => withHome(async (home) => {
  const selectedState = join(home, '.ours-selected');
  const configPath = join(home, 'client', 'config.json');
  mkdirSync(join(home, 'client'), { recursive: true });
  const answers = new Map([
    ['Choose profile', 'm'],
    ['Profile id', 'selected'],
    ['Profile label', 'Selected existing daemon'],
    ['Host', '127.0.0.1'],
    ['Port', '3060'],
    ['Exact state directory', selectedState],
    ['Existing/client config path', configPath],
    ['Service instance name', 'selected'],
  ]);
  for (const [label, config] of [
    ['string port', { port: '3060', stateDir: selectedState }],
    ['null port', { port: null, stateDir: selectedState }],
    ['non-string state directory', { port: 3060, stateDir: { path: selectedState } }],
  ]) {
    writeFileSync(configPath, JSON.stringify(config) + '\n', { mode: 0o600 });
    const { deps, calls } = makeDeps({
      ask: (prompt, def) => [...answers].find(([key]) => prompt.includes(key))?.[1] ?? def,
      probe: async (candidate) => ({ ...candidate, reachable: true, compatible: true }),
      fetch: async (url) => String(url).endsWith('/info')
        ? Response.json({ name: 'ours', stateDir: selectedState })
        : String(url).endsWith('/version')
          ? Response.json({ version: '0.16.0-nightly' })
          : Response.json({ identities: [] }),
    });
    await runNightlyInstaller(deps);
    assert.equal(existsSync(profilesPath(process.env, home)), false,
      `${label}: an ignored value must not associate a runtime-drifted profile`);
    assert.equal(calls.length, 0,
      `${label}: no package, marketplace/plugin, service, identity, or registry mutation starts`);
  }
}));

test('default and legacy discovery mirror runtime types and historical defaults', async () => {
  for (const { id, directory } of [
    { id: 'default', directory: '.ours' },
    { id: 'tg', directory: '.ours-tg' },
  ]) {
    await withHome(async (home) => {
      const configDir = join(home, directory);
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, 'config.json'), JSON.stringify({
        port: '3060',
        stateDir: { path: configDir },
      }) + '\n');
      const probed = [];
      const { deps, calls } = makeDeps({
        probe: async (candidate) => {
          probed.push(candidate);
          return { ...candidate, reachable: true, compatible: false, error: 'stop after discovery' };
        },
      });
      await runNightlyInstaller(deps);
      const candidate = probed.find((value) => value.id === id);
      assert.ok(candidate, `${id} config is retained as a deterministic candidate`);
      assert.equal(candidate.port, 3050, `${id} ignores a string file port like core/src/config.ts`);
      assert.equal(candidate.stateDir, join(home, '.ours'), `${id} ignores a non-string stateDir and uses the runtime default`);
      assert.equal(calls.length, 0, `${id} discovery validation performs no mutation`);
    });
  }
});

test('a discovered registry profile with runtime-ignored config values rejects drift before mutation', async () => withHome(async (home) => {
  const stateDir = join(home, '.ours-tg');
  const configPath = join(stateDir, 'config.json');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(configPath, JSON.stringify({ port: '3060', stateDir: { path: stateDir } }) + '\n');
  const registryPath = profilesPath(process.env, home);
  writeRegistry(registryPath, {
    version: 1,
    profiles: { tg: {
      label: 'Legacy tg daemon', host: '127.0.0.1', port: 3060, configPath, stateDir, serviceName: 'tg',
      ownership: { config: false, service: false, state: false },
    } },
    harnessAssociations: {},
  });
  const before = readFileSync(registryPath, 'utf8');
  const { deps, calls } = makeDeps({
    ask: (prompt, def) => prompt.includes('Choose profile') ? '1' : def,
    probe: async (candidate) => ({ ...candidate, reachable: true, compatible: true }),
    fetch: async (url) => String(url).endsWith('/info')
      ? Response.json({ name: 'ours', stateDir })
      : String(url).endsWith('/version')
        ? Response.json({ version: '0.16.0-nightly' })
        : Response.json({ identities: [] }),
  });
  await runNightlyInstaller(deps);
  assert.equal(calls.length, 0, 'package, marketplace/plugin, service, identity, and registry mutation never starts');
  assert.equal(readFileSync(registryPath, 'utf8'), before, 'profile registry bytes remain unchanged');
}));

test('generated named launchd values XML-decode exactly and rediscovery is idempotent', async () => withHome(async (home) => {
  const id = 'special';
  const stateDir = join(home, `.ours-${id}&state<nightly>"quote"'apostrophe`);
  const configPath = join(stateDir, `config&auth<nightly>"quote"'apostrophe.json`);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(configPath, JSON.stringify({ port: 3063, stateDir }) + '\n');
  const launchAgents = join(home, 'Library', 'LaunchAgents');
  mkdirSync(launchAgents, { recursive: true });
  writeFileSync(join(launchAgents, `solutions.adaptframework.ours.${id}.plist`), namedPlist({
    id, configPath, port: 3063, stateDir,
  }));
  const discoveries = [];
  for (let rerun = 0; rerun < 2; rerun += 1) {
    const probed = [];
    const { deps, calls } = makeDeps({
      probe: async (candidate) => {
        probed.push(candidate);
        return { ...candidate, reachable: true, compatible: false, error: 'stop after discovery' };
      },
    });
    await runNightlyInstaller(deps);
    const candidate = probed.find((value) => value.id === id);
    assert.ok(candidate, 'generated named plist is rediscovered');
    assert.equal(candidate.configPath, configPath);
    assert.equal(candidate.stateDir, stateDir);
    assert.equal(candidate.port, 3063);
    assert.equal(calls.length, 0, 'rediscovery performs no mutation');
    discoveries.push(candidate);
  }
  assert.deepEqual(discoveries[1], discoveries[0], 'same generated plist yields the same candidate on rerun');
}));

test('launchd discovery fails closed on malformed XML entities before probing or mutation', async () => withHome(async (home) => {
  const launchAgents = join(home, 'Library', 'LaunchAgents');
  mkdirSync(launchAgents, { recursive: true });
  const plist = namedPlist({
    id: 'broken', configPath: join(home, '.ours-broken', 'config.json'), port: 3064,
    stateDir: join(home, '.ours-broken'),
  }).replace('.ours-broken', '.ours&bogus;-broken');
  writeFileSync(join(launchAgents, 'solutions.adaptframework.ours.broken.plist'), plist);
  let probes = 0;
  const { deps, calls } = makeDeps({
    probe: async (candidate) => { probes += 1; return candidate; },
  });
  await runNightlyInstaller(deps);
  assert.equal(probes, 0, 'malformed entity aborts discovery instead of becoming literal path bytes');
  assert.equal(calls.length, 0, 'malformed plist performs no mutation');
}));

test('new-profile service failure transactionally records retained config/service/state ownership without associations', async () => withHome(async (home) => {
  process.env.OURS_ASSUME_YES = '1';
  const stateDir = join(home, '.ours');
  const configPath = join(stateDir, 'config.json');
  let starts = 0;
  const { deps } = makeDeps({
    fetch: async () => { throw new Error('not listening yet'); },
    run: (bin, args) => {
      if (bin === 'ours-mcp' && args[0] === 'start') { starts += 1; return { ok: true, code: 0 }; }
      if (bin === 'ours-mcp' && args[0] === 'install-service') {
        const unitDir = join(home, '.config', 'systemd', 'user');
        mkdirSync(unitDir, { recursive: true });
        writeFileSync(join(unitDir, 'ours.service'), '[Service]\n');
        return { ok: false, code: 1 };
      }
      return { ok: true, code: 0, out: '', err: '' };
    },
  });
  await runNightlyInstaller(deps);
  assert.equal(starts, 2, 'one start plus service-failure recovery');
  assert.equal(existsSync(configPath), true, 'new daemon config is retained for recovered partial state');
  assert.equal(existsSync(stateDir), true, 'new state directory is retained after partial failure');
  const recovered = readRegistry(profilesPath(process.env, home));
  assert.deepEqual(recovered.harnessAssociations, {}, 'no application association commits on partial failure');
  assert.deepEqual(recovered.profiles.default.ownership, { config: true, service: true, state: true });
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

test('topology-first Rooms attaches to the exact preselected named profile without provisioning another daemon', async () => withHome(async (home) => {
  const stateDir = join(home, '.ours-rooms-daemon');
  const configPath = join(stateDir, 'config.json');
  writeRegistry(profilesPath(process.env, home), {
    version: 1,
    profiles: { work: {
      label: 'Work daemon', host: '127.0.0.1', port: 3085, configPath, stateDir, serviceName: 'work',
      ownership: { config: true, service: true, state: true },
    } },
    harnessAssociations: {},
  });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(configPath, JSON.stringify({ port: 3085, stateDir, serviceName: 'work' }) + '\n');
  const yes = (prompt, def) => {
    if (prompt.includes('Use profile')) return false;
    if (prompt.includes('ours-fleet')) return false;
    if (prompt.includes('Point Telegram')) return false;
    if (prompt.includes('Point Rooms')) return true;
    return def;
  };
  const { deps, calls } = makeDeps({
    ask: (prompt, def) => prompt.includes('Choose profile') ? '1' : def,
    yes,
    probe: async (candidate) => ({ ...candidate, reachable: true, compatible: true }),
    fetch: async (url) => String(url).endsWith('/info')
      ? Response.json({ name: 'ours', stateDir })
      : String(url).endsWith('/version')
        ? Response.json({ version: '0.16.0-nightly' })
        : Response.json({ identities: [] }),
    run: (bin, args) => {
      if (bin === 'npm' && args.includes('@ours.network/cowork')) {
        return { ok: true, code: 0, out: JSON.stringify({ dependencies: { '@ours.network/cowork': { version: COWORK_EXTERNAL_MIN_VERSION } } }), err: '' };
      }
      return { ok: true, code: 0, out: '', err: '' };
    },
  });
  await runNightlyInstaller(deps);
  const roomsPath = join(home, '.ours-cowork', 'config.json');
  const rooms = JSON.parse(readFileSync(roomsPath, 'utf8'));
  assert.deepEqual(rooms.daemon, {
    mode: 'external', endpoint: 'http://127.0.0.1:3085', stateDir,
  });
  assert.ok(calls.some((call) => call.bin === 'ours-cowork' && call.args[0] === 'install-service'));
  assert.equal(calls.some((call) => call.bin === 'ours-mcp' && ['start', 'install-service'].includes(call.args[0])), false,
    'an existing selected profile is not replaced by a consumer-specific daemon');
}));

test('topology-first Rooms rerun preserves operator keys and the exact selected daemon block', async () => withHome(async (home) => {
  const stateDir = join(home, '.ours');
  const configPath = join(stateDir, 'config.json');
  writeRegistry(profilesPath(process.env, home), {
    version: 1,
    profiles: { default: {
      label: 'Default', host: '127.0.0.1', port: 3050, configPath, stateDir, serviceName: '',
      ownership: { config: true, service: true, state: true },
    } },
    harnessAssociations: {},
  });
  writeFileSync(configPath, JSON.stringify({ port: 3050, stateDir }) + '\n');
  const roomsPath = join(home, '.ours-cowork', 'config.json');
  mkdirSync(join(home, '.ours-cowork'), { recursive: true });
  const initialRooms = {
    version: 1, brokerUrl: 'wss://broker1.ours.network', stateDir: join(home, '.ours-cowork'),
    rest: { enabled: true, port: 3052 }, operatorNote: 'keep me',
    daemon: { mode: 'external', endpoint: 'http://127.0.0.1:3050', stateDir },
  };
  writeFileSync(roomsPath, JSON.stringify(initialRooms, null, 2) + '\n', { mode: 0o600 });
  const { deps } = makeDeps({
    ask: (prompt, def) => prompt.includes('Choose profile') ? '1' : def,
    yes: (prompt, def) => prompt.includes('Point Rooms') ? true
      : prompt.includes('Use profile') || prompt.includes('ours-fleet') || prompt.includes('Point Telegram') ? false : def,
    probe: async (candidate) => ({ ...candidate, reachable: true, compatible: true }),
    fetch: async (url) => String(url).endsWith('/info')
      ? Response.json({ name: 'ours', stateDir })
      : String(url).endsWith('/version')
        ? Response.json({ version: '0.16.0-nightly' })
        : Response.json({ identities: [] }),
    run: (bin, args) => bin === 'npm' && args.includes('@ours.network/cowork')
      ? { ok: true, code: 0, out: JSON.stringify({ dependencies: { '@ours.network/cowork': { version: COWORK_EXTERNAL_MIN_VERSION } } }), err: '' }
      : { ok: true, code: 0, out: '', err: '' },
  });
  await runNightlyInstaller(deps);
  assert.deepEqual(JSON.parse(readFileSync(roomsPath, 'utf8')), initialRooms);
}));
