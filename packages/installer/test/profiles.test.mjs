import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PROFILE_REGISTRY_VERSION, ProfileRegistryError, associateHarness, dedupeCandidates,
  defaultHistoricalProfile, discoverProfileCandidates, emptyRegistry, normalizeLoopbackHost,
  normalizeProfile, profilesPath, readRegistry, removeHarnessAssociation, reverseApplicationIndex,
  probeProfileCandidate, upsertProfile, validateRegistry, writeRegistry,
} from '../lib/profiles.mjs';

const root = () => mkdtempSync(join(tmpdir(), 'ours-profiles-'));
const profile = (home, overrides = {}) => ({
  label: 'Default daemon', host: '127.0.0.1', port: 3050,
  configPath: join(home, '.ours', 'config.json'), stateDir: join(home, '.ours'), serviceName: '',
  ownership: { config: true, service: true, state: true },
  ...overrides,
});
const named = (home, id, port, overrides = {}) => profile(home, {
  label: `${id} daemon`, port, configPath: join(home, `.ours-${id}`, 'config.json'),
  stateDir: join(home, `.ours-${id}`), serviceName: id,
  ...overrides,
});
const registryWith = (home) => ({
  version: PROFILE_REGISTRY_VERSION,
  profiles: { default: profile(home) },
  harnessAssociations: {},
});

test('schema v1 normalizes localhost and rejects unsupported versions or unknown fields that imply secrets', () => {
  const home = root();
  const value = registryWith(home);
  value.profiles.default.host = 'localhost';
  assert.equal(validateRegistry(value).profiles.default.host, '127.0.0.1');
  assert.equal(normalizeLoopbackHost('127.0.0.1'), '127.0.0.1');
  for (const host of ['::1', '0.0.0.0', 'host.test', 'http://127.0.0.1', '127.0.0.1:3050', 'https://localhost']) {
    assert.throws(() => normalizeLoopbackHost(host), /localhost or 127\.0\.0\.1/);
  }
  assert.throws(() => validateRegistry({ ...value, version: 2 }), /unsupported profile registry version/);
  assert.throws(() => validateRegistry({ ...value, apiToken: 'never' }), (e) => e.code === 'SECRET_IN_REGISTRY');
  assert.throws(() => validateRegistry({ ...value, status: 'running' }), (e) => e.code === 'INVALID_SCHEMA');
  const withPid = structuredClone(value);
  withPid.profiles.default.pid = 42;
  assert.throws(() => validateRegistry(withPid), (e) => e.code === 'INVALID_SCHEMA');
});

test('profile validation requires absolute normalized paths, explicit ownership, valid ids and default-only empty service', () => {
  const home = root();
  assert.deepEqual(normalizeProfile('default', profile(home)).ownership, { config: true, service: true, state: true });
  assert.throws(() => normalizeProfile('bad id', profile(home)), /profile id/);
  assert.throws(() => normalizeProfile('other', named(home, 'other', 3060, { configPath: 'relative.json' })), /absolute path/);
  assert.throws(() => normalizeProfile('other', named(home, 'other', 3060, { stateDir: `${home}/x/../y` })), /normalized absolute path/);
  assert.throws(() => normalizeProfile('other', named(home, 'other', 3060, { ownership: undefined })), /explicit ownership/);
  assert.throws(() => normalizeProfile('other', named(home, 'other', 3060, { serviceName: '' })), /reserved for profile "default"/);
  assert.throws(() => normalizeProfile('other', named(home, 'other', 3060, { daemonToken: 'secret' })), (e) => e.code === 'SECRET_IN_REGISTRY');
});

test('registry writes atomically at 0600 and an identical write is idempotent', () => {
  const home = root();
  const path = profilesPath({}, home);
  const registry = registryWith(home);
  assert.deepEqual(writeRegistry(path, registry), { changed: true, path });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const bytes = readFileSync(path, 'utf8');
  assert.deepEqual(readRegistry(path), validateRegistry(registry));
  assert.deepEqual(writeRegistry(path, registry), { changed: false, path });
  assert.equal(readFileSync(path, 'utf8'), bytes);
});

test('missing registry is empty; corrupt JSON and unsupported schemas fail closed', () => {
  const home = root();
  const path = join(home, 'registry.json');
  assert.deepEqual(readRegistry(path), emptyRegistry());
  writeFileSync(path, '{nope', { mode: 0o600 });
  assert.throws(() => readRegistry(path), (e) => e instanceof ProfileRegistryError && e.code === 'CORRUPT_JSON');
  writeFileSync(path, JSON.stringify({ version: 99, profiles: {}, harnessAssociations: {} }));
  assert.throws(() => readRegistry(path), (e) => e.code === 'UNSUPPORTED_VERSION');
});

test('upsert blocks endpoint, state, config, and service collisions without inferring ownership', () => {
  const home = root();
  const base = registryWith(home);
  for (const [field, value] of [
    ['port', 3050],
    ['stateDir', join(home, '.ours')],
    ['configPath', join(home, '.ours', 'config.json')],
    ['serviceName', ''],
  ]) {
    const candidate = named(home, 'other', 3060, { [field]: value });
    if (field === 'serviceName') {
      assert.throws(() => upsertProfile(base, 'other', candidate), /empty serviceName is reserved/);
    } else {
      assert.throws(() => upsertProfile(base, 'other', candidate), (e) => e.code === 'PROFILE_COLLISION');
    }
  }
  const next = upsertProfile(base, 'other', named(home, 'other', 3060));
  assert.equal(next.profiles.other.ownership.service, true);
});

test('one harness association requires explicit reassignment and can be removed independently', () => {
  const home = root();
  let registry = upsertProfile(registryWith(home), 'other', named(home, 'other', 3060));
  let result = associateHarness(registry, 'codex', 'default');
  registry = result.registry;
  assert.equal(result.changed, true);
  assert.throws(() => associateHarness(registry, 'codex', 'other'), (e) => e.code === 'REASSIGN_CONFIRMATION_REQUIRED');
  result = associateHarness(registry, 'codex', 'other', { allowReassign: true });
  assert.equal(result.previous, 'default');
  const removed = removeHarnessAssociation(result.registry, 'codex');
  assert.equal(removed.changed, true);
  assert.deepEqual(removed.registry.harnessAssociations, {});
});

test('reverse application index combines runtime harness associations with real Telegram and Rooms config', () => {
  const home = root();
  let registry = upsertProfile(registryWith(home), 'rooms', named(home, 'rooms', 3060));
  registry = associateHarness(registry, 'claude-code', 'default').registry;
  registry = associateHarness(registry, 'codex', 'rooms').registry;
  const index = reverseApplicationIndex(registry, {
    telegramConfig: { daemonUrl: 'http://localhost:3050', daemonStateDir: join(home, '.ours') },
    roomsConfig: { daemon: { mode: 'external', endpoint: 'http://127.0.0.1:3060', stateDir: join(home, '.ours-rooms') } },
  });
  assert.deepEqual(index.default, ['claude-code', 'telegram']);
  assert.deepEqual(index.rooms, ['codex', 'rooms']);
});

test('reverse application index canonicalizes connector state paths and fails closed on errors', () => {
  const home = root();
  const stateDir = join(home, 'state');
  const alias = join(home, 'state-alias');
  mkdirSync(stateDir);
  symlinkSync(stateDir, alias, 'dir');
  const registry = registryWith(home);
  registry.profiles.default.stateDir = stateDir;
  registry.profiles.default.configPath = join(stateDir, 'config.json');

  assert.deepEqual(reverseApplicationIndex(registry, {
    telegramConfig: { daemonUrl: 'http://127.0.0.1:3050', daemonStateDir: alias },
  }).default, ['telegram'], 'a real symlink alias remains an in-use dependency');

  assert.deepEqual(reverseApplicationIndex(registry, {
    roomsConfig: { daemon: { endpoint: 'http://127.0.0.1:3050', stateDir: join(home, 'missing', '..', 'state') } },
  }).default, ['rooms'], 'equivalent lexical paths match without requiring the path to exist');

  assert.deepEqual(reverseApplicationIndex(registry, {
    telegramConfig: { daemonUrl: 'http://127.0.0.1:3050', daemonStateDir: join(home, 'other-missing') },
  }).default, [], 'distinct missing paths remain distinct');

  const missingState = join(home, 'missing-state');
  const missingRegistry = registryWith(home);
  missingRegistry.profiles.default.stateDir = missingState;
  missingRegistry.profiles.default.configPath = join(missingState, 'config.json');
  assert.deepEqual(reverseApplicationIndex(missingRegistry, {
    telegramConfig: { daemonUrl: 'http://127.0.0.1:3050', daemonStateDir: missingState },
  }).default, ['telegram'], 'the same nonexistent path remains a dependency');

  const parent = join(home, 'parent');
  const parentAlias = join(home, 'parent-alias');
  mkdirSync(parent);
  symlinkSync(parent, parentAlias, 'dir');
  missingRegistry.profiles.default.stateDir = join(parent, 'not-created');
  missingRegistry.profiles.default.configPath = join(parent, 'not-created', 'config.json');
  assert.deepEqual(reverseApplicationIndex(missingRegistry, {
    roomsConfig: { daemon: { endpoint: 'http://127.0.0.1:3050', stateDir: join(parentAlias, 'not-created') } },
  }).default, ['rooms'], 'a missing leaf below a symlinked ancestor canonicalizes deterministically');

  const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  const unreadableConfig = {
    telegramConfig: { daemonUrl: 'http://127.0.0.1:3050', daemonStateDir: join(home, 'uninspectable') },
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.deepEqual(reverseApplicationIndex(registry, unreadableConfig, {
      realpath: () => { throw denied; },
    }).default, ['telegram'], 'an uninspectable endpoint match is retained consistently');
  }
  assert.deepEqual(reverseApplicationIndex(registry, {
    telegramConfig: { ...unreadableConfig.telegramConfig, daemonUrl: 'http://127.0.0.1:3060' },
  }, { realpath: () => { throw denied; } }).default, [],
  'a canonicalization error does not invent a dependency on a different endpoint');
});

test('candidate dedupe requires both endpoint and canonical stateDir and rejects ambiguous collisions', () => {
  const home = root();
  mkdirSync(join(home, '.ours'), { recursive: true });
  const a = { id: 'default', ...profile(home), origin: 'registry' };
  const duplicate = { id: 'legacy', ...named(home, 'legacy', 3050, {
    stateDir: join(home, '.ours'), configPath: join(home, '.ours-legacy', 'config.json'),
  }), origin: 'legacy' };
  assert.equal(dedupeCandidates([a, duplicate]).length, 1);
  assert.deepEqual(dedupeCandidates([a, duplicate])[0].origins, ['registry', 'legacy']);
  const wrongState = { ...duplicate, stateDir: join(home, '.wrong') };
  assert.throws(() => dedupeCandidates([a, wrongState]), (e) => e.code === 'DISCOVERY_COLLISION');
  const wrongEndpoint = { ...duplicate, port: 3060 };
  assert.throws(() => dedupeCandidates([a, wrongEndpoint]), (e) => e.code === 'DISCOVERY_COLLISION');
});

test('discovery is deterministic, probes only supplied candidates, and retains stopped configured candidates', async () => {
  const home = root();
  const registry = registryWith(home);
  const calls = [];
  const found = await discoverProfileCandidates({
    registry,
    serviceCandidates: [{ id: 'svc', ...named(home, 'svc', 3060) }],
    probe: async (candidate) => {
      calls.push(`${candidate.host}:${candidate.port}`);
      return { ...candidate, reachable: candidate.port === 3050 };
    },
  });
  assert.deepEqual(calls, ['127.0.0.1:3050', '127.0.0.1:3060']);
  assert.equal(found[1].reachable, false);
  assert.equal(found[1].configured, true);
  assert.equal(calls.length, 2, 'no range or ambient port scan occurred');
});

test('reachable discovery candidates must pass both /info and /version', async () => {
  const home = root();
  const candidate = { id: 'default', ...profile(home) };
  const stateDir = join(home, '.ours');
  const good = await probeProfileCandidate(candidate, {
    fetch: async (url) => String(url).endsWith('/info')
      ? Response.json({ name: 'ours', stateDir, version: '1.2.3' })
      : Response.json({ version: '1.2.3' }),
  });
  assert.equal(good.compatible, true);
  assert.equal(good.version, '1.2.3');
  const missingVersion = await probeProfileCandidate(candidate, {
    fetch: async (url) => String(url).endsWith('/info')
      ? Response.json({ name: 'ours', stateDir })
      : new Response('missing', { status: 404 }),
  });
  assert.equal(missingVersion.reachable, true);
  assert.equal(missingVersion.compatible, false);
  assert.match(missingVersion.error, /\/version/);
});

test('historical profile is the exact default topology and carries explicit installer ownership', () => {
  const home = root();
  assert.deepEqual(defaultHistoricalProfile(home), profile(home, { label: 'Default ours daemon' }));
});
