import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runNightlyInstaller } from '../lib/nightly-install.mjs';
import { profilesPath, readRegistry, writeRegistry } from '../lib/profiles.mjs';
import { COWORK_EXTERNAL_MIN_VERSION } from '../lib/logic.mjs';

// The default `fetch` for every test: a loud refusal rather than the real network.
const refuseRealFetch = async (url) => {
  throw new Error(
    `test attempted a REAL network request to ${String(url)} — inject a fetch/probe instead. ` +
    'The installer defaults to 127.0.0.1:3050, which is a live daemon on many hosts.',
  );
};

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
      // NEVER let a test fall through to the real network. Left undefined, the
      // installer's probes use globalThis.fetch, and their default target is
      // 127.0.0.1:3050 — the ordinary production port, which on a developer's or
      // fleet host is answered by a REAL daemon. That is how a suite ends up
      // making live HTTP requests to somebody's running daemon, and how a test can
      // pass for a reason that has nothing to do with the code: an unexpected
      // listener changed the installer's path and the assertions held by luck.
      // A test that means to exercise an endpoint injects one.
      fetch: fetch ?? refuseRealFetch,
      probe,
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

function systemdService(env) {
  return `[Service]\n${Object.entries(env).map(([key, value]) => `Environment=${key}=${value}`).join('\n')}\n`;
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

test('service discovery shares runtime file types, defaults, and environment precedence', async () => {
  const cases = [
    { label: 'string port and object state', config: (home) => ({ port: '4060', stateDir: { path: join(home, 'wrong') } }), port: 3050, state: (home) => join(home, '.ours') },
    { label: 'null values', config: () => ({ port: null, stateDir: null }), port: 3050, state: (home) => join(home, '.ours') },
    { label: 'array values', config: () => ({ port: [3060], stateDir: ['wrong'] }), port: 3050, state: (home) => join(home, '.ours') },
    { label: 'boolean values', config: () => ({ port: true, stateDir: false }), port: 3050, state: (home) => join(home, '.ours') },
    { label: 'empty string port and valid empty string state', config: () => ({ port: '', stateDir: '' }), port: 3050, state: () => resolve('') },
    { label: 'overflowing numeric port', raw: () => '{"port":1e999,"stateDir":42}\n', port: 3050, state: (home) => join(home, '.ours') },
    { label: 'omitted values', config: () => ({}), port: 3050, state: (home) => join(home, '.ours') },
    { label: 'valid file values', config: (home) => ({ port: 3060, stateDir: join(home, 'configured-state') }), port: 3060, state: (home) => join(home, 'configured-state') },
    { label: 'valid service values override file', config: (home) => ({ port: 3060, stateDir: join(home, 'configured-state') }), env: (home) => ({ OURS_PORT: '3077tail', OURS_STATE_DIR: join(home, 'service-state') }), port: 3077, state: (home) => join(home, 'service-state') },
    { label: 'NaN service port falls back to file', config: (home) => ({ port: 3061, stateDir: join(home, 'configured-state') }), env: () => ({ OURS_PORT: 'NaN' }), port: 3061, state: (home) => join(home, 'configured-state') },
    { label: 'infinite service port falls back to file', config: (home) => ({ port: 3062, stateDir: join(home, 'configured-state') }), env: () => ({ OURS_PORT: 'Infinity' }), port: 3062, state: (home) => join(home, 'configured-state') },
    { label: 'empty service port falls back to file', config: (home) => ({ port: 3063, stateDir: join(home, 'configured-state') }), env: () => ({ OURS_PORT: '' }), port: 3063, state: (home) => join(home, 'configured-state') },
    { label: 'empty service state remains an explicit string', config: (home) => ({ port: 3064, stateDir: join(home, 'configured-state') }), env: () => ({ OURS_STATE_DIR: '' }), port: 3064, state: () => resolve('') },
  ];
  for (const entry of cases) {
    await withHome(async (home) => {
      const configPath = join(home, 'service-config.json');
      const serviceDir = join(home, '.config', 'systemd', 'user');
      mkdirSync(serviceDir, { recursive: true });
      writeFileSync(configPath, entry.raw ? entry.raw(home) : JSON.stringify(entry.config(home)) + '\n');
      writeFileSync(join(serviceDir, 'ours.service'), systemdService({
        OURS_CONFIG: configPath,
        ...(entry.env ? entry.env(home) : {}),
      }));
      const probed = [];
      const { deps, calls } = makeDeps({
        probe: async (candidate) => {
          probed.push(candidate);
          return { ...candidate, reachable: true, compatible: false, error: 'stop after discovery' };
        },
      });
      await runNightlyInstaller(deps);
      const candidate = probed.find((value) => value.id === 'default');
      assert.ok(candidate, `${entry.label}: service remains discoverable`);
      assert.equal(candidate.port, entry.port, `${entry.label}: port matches core runtime resolution`);
      assert.equal(candidate.stateDir, entry.state(home), `${entry.label}: stateDir matches core runtime resolution`);
      assert.equal(calls.length, 0, `${entry.label}: discovery performs no mutation`);
    });
  }
});

test('OURS_CONFIG-only services remove false collisions and retain exact named-profile behavior', async () => {
  await withHome(async (home) => {
    const stateDir = join(home, '.ours');
    const configPath = join(stateDir, 'config.json');
    const serviceDir = join(home, '.config', 'systemd', 'user');
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(serviceDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify({ port: '4060', stateDir }) + '\n');
    writeFileSync(join(serviceDir, 'ours.service'), systemdService({ OURS_CONFIG: configPath }));
    const probed = [];
    const { deps, calls } = makeDeps({
      probe: async (candidate) => {
        probed.push(candidate);
        return { ...candidate, reachable: true, compatible: false, error: 'stop after discovery' };
      },
    });
    await runNightlyInstaller(deps);
    assert.equal(probed.length, 1, 'default config and service resolve to one exact endpoint instead of a false collision');
    assert.equal(probed[0].port, 3050);
    assert.equal(probed[0].stateDir, stateDir);
    assert.deepEqual(probed[0].origins, ['default-config', 'known-service']);
    assert.equal(calls.length, 0, 'false-collision discovery performs no mutation');
  });

  await withHome(async (home) => {
    const configPath = join(home, 'named-config.json');
    const serviceDir = join(home, '.config', 'systemd', 'user');
    mkdirSync(serviceDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify({ port: '4060', stateDir: { path: join(home, '.ours-blue') } }) + '\n');
    writeFileSync(join(serviceDir, 'ours-blue.service'), systemdService({ OURS_CONFIG: configPath }));
    const probed = [];
    const { deps, calls } = makeDeps({
      probe: async (candidate) => {
        probed.push(candidate);
        return { ...candidate, reachable: true, compatible: false, error: 'stop after discovery' };
      },
    });
    await runNightlyInstaller(deps);
    assert.equal(probed.length, 1);
    assert.equal(probed[0].id, 'blue');
    assert.equal(probed[0].serviceName, 'blue');
    assert.equal(probed[0].configPath, configPath);
    assert.equal(probed[0].port, 3050, 'named services use the historical runtime default, not an invented named default');
    assert.equal(probed[0].stateDir, join(home, '.ours'), 'named services use the historical runtime state default');
    assert.equal(calls.length, 0, 'named-profile discovery performs no mutation');
  });
});

test('real service discovery collisions still reject before probes or mutations', async () => withHome(async (home) => {
  const serviceDir = join(home, '.config', 'systemd', 'user');
  const sharedState = join(home, 'shared-state');
  const defaultConfig = join(home, 'default-config.json');
  const blueConfig = join(home, 'blue-config.json');
  mkdirSync(serviceDir, { recursive: true });
  writeFileSync(defaultConfig, JSON.stringify({ port: 3050, stateDir: sharedState }) + '\n');
  writeFileSync(blueConfig, JSON.stringify({ port: 3060, stateDir: sharedState }) + '\n');
  writeFileSync(join(serviceDir, 'ours.service'), systemdService({ OURS_CONFIG: defaultConfig }));
  writeFileSync(join(serviceDir, 'ours-blue.service'), systemdService({ OURS_CONFIG: blueConfig }));
  let probes = 0;
  const { deps, calls } = makeDeps({
    probe: async (candidate) => { probes += 1; return candidate; },
  });
  await runNightlyInstaller(deps);
  assert.equal(probes, 0, 'collision rejects the entire candidate set before endpoint probing');
  assert.equal(calls.length, 0, 'no package, service, harness, identity, or registry mutation starts');
  assert.equal(existsSync(profilesPath(process.env, home)), false, 'rejection does not create the profile registry');
}));

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

// ours-fleet resolves its daemon from OURS_CONFIG / OURS_PORT / OURS_STATE_DIR and
// otherwise falls back to ~/.ours and port 3050; it has no concept of this registry.
// So `ours-fleet init` run with no environment silently points every role at the
// historical default daemon — which, for any profile that is not the default, is a
// different daemon and may be one that does not exist on this machine at all. It has
// to receive the same exact environment as every other selected-profile command here.
test('ours-fleet init receives the selected profile environment, not the historical default', async () => withHome(async (home) => {
  const stateDir = join(home, '.ours-work');
  const configPath = join(stateDir, 'config.json');
  writeRegistry(profilesPath(process.env, home), {
    version: 1,
    profiles: { work: {
      label: 'Work daemon', host: '127.0.0.1', port: 3085, configPath, stateDir, serviceName: 'work',
      ownership: { config: false, service: false, state: false },
    } },
    harnessAssociations: {},
  });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(configPath, JSON.stringify({ port: 3085, stateDir, serviceName: 'work' }) + '\n');
  const { deps, calls } = makeDeps({
    ask: (prompt, def) => prompt.includes('Choose profile') ? '1' : def,
    yes: (prompt, def) => prompt.includes('ours-fleet') ? true
      : prompt.includes('Use profile') || prompt.includes('Point Telegram') || prompt.includes('Point Rooms') ? false : def,
    probe: async (candidate) => ({ ...candidate, reachable: true, compatible: true }),
    fetch: async (url) => String(url).endsWith('/info')
      ? Response.json({ name: 'ours', stateDir })
      : String(url).endsWith('/version')
        ? Response.json({ version: '0.16.0-nightly' })
        : Response.json({ identities: [] }),
  });
  await runNightlyInstaller(deps);
  const init = calls.find((call) => call.bin === 'ours-fleet' && call.args[0] === 'init');
  assert.ok(init, 'ours-fleet init ran');
  assert.equal(init.options?.env?.OURS_CONFIG, configPath, 'init is given the selected profile config');
  assert.equal(init.options?.env?.OURS_PORT, '3085', 'init is given the selected profile port');
  assert.equal(init.options?.env?.OURS_STATE_DIR, stateDir, 'init is given the selected profile state directory');
  assert.equal(init.options?.env?.OURS_SERVICE_NAME, 'work', 'init is given the selected instance name');
}));
// The guard above only works while it is still there. This is what stops it being
// quietly dropped back to `fetch` (undefined) by a future edit — at which point
// every probe in this file would silently target 127.0.0.1:3050 again.
//
// Provenance: an earlier version of the discovery change disarmed a fail-closed
// path, and this suite stayed GREEN locally while failing in CI, because the
// installer fell through to probing 3050 and got a REAL daemon on the developer's
// machine. It aborted, so nothing was mutated — but "it aborted" was luck, not a
// property of the test.
test('the default deps refuse a real network request instead of reaching a live daemon', async () => {
  const { deps } = makeDeps();
  await assert.rejects(
    () => deps.fetch('http://127.0.0.1:3050/info'),
    /REAL network request/,
    'an un-injected fetch fails loudly rather than talking to whatever is on 3050',
  );
});
