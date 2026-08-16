import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AssociationError, assertApplicationCommand, parseApplicationArgs, resolveRuntimeAssociation,
  verifyRuntimeAssociation,
} from '../dist/association.js';

const home = mkdtempSync(join(tmpdir(), 'ours-association-'));
const stateDir = join(home, '.ours-blue');
const configPath = join(stateDir, 'config.json');
const registryPath = join(home, 'profiles.json');
mkdirSync(stateDir, { recursive: true });
writeFileSync(configPath, JSON.stringify({ port: 3060, stateDir, apiToken: 'config-secret', autoStart: true }) + '\n');
const registry = {
  version: 1,
  profiles: {
    blue: {
      label: 'Blue', host: 'localhost', port: 3060, configPath, stateDir, serviceName: 'blue',
      ownership: { config: true, service: true, state: true },
    },
  },
  harnessAssociations: { codex: 'blue' },
};
writeFileSync(registryPath, JSON.stringify(registry) + '\n', { mode: 0o600 });
const env = { HOME: home, OURS_INSTALL_PROFILES: registryPath };

console.log('association\n');

assert.deepEqual(parseApplicationArgs(['proxy', '--application', 'codex', '--x']), {
  application: 'codex', argv: ['proxy', '--x'],
});
assert.deepEqual(parseApplicationArgs(['watch', '--application=hermes', 'Alice']), {
  application: 'hermes', argv: ['watch', 'Alice'],
});
assert.throws(() => parseApplicationArgs(['proxy', '--application', 'unknown']), (e) => e.code === 'INVALID_APPLICATION');
console.log('  ✓ --application parses before command arguments and rejects unknown applications');

const selected = resolveRuntimeAssociation('codex', env, home);
assert.equal(selected.profileId, 'blue');
assert.equal(selected.profile.host, '127.0.0.1');
assert.equal(selected.profile.configPath, configPath);
assert.equal(resolveRuntimeAssociation('claude-code', env, home), null, 'unassociated harness keeps legacy config');
for (const explicit of [
  { OURS_PORT: '3099' }, { OURS_CONFIG: join(home, 'manual.json') }, { OURS_STATE_DIR: join(home, 'manual-state') },
]) {
  assert.equal(resolveRuntimeAssociation('codex', { ...env, ...explicit }, home), null, 'explicit env wins over registry');
}
console.log('  ✓ registry association follows explicit env and precedes legacy fallback');

const original = JSON.parse(JSON.stringify(registry));
original.profiles.blue.port = 3061;
writeFileSync(registryPath, JSON.stringify(original));
assert.throws(() => resolveRuntimeAssociation('codex', env, home), (e) => e.code === 'CONFIG_DRIFT');
writeFileSync(registryPath, '{bad');
assert.throws(() => resolveRuntimeAssociation('codex', env, home), (e) => e.code === 'CORRUPT_JSON');
writeFileSync(registryPath, JSON.stringify(registry));
console.log('  ✓ corrupt registry and config port/state drift fail closed');

const defaultsHome = mkdtempSync(join(tmpdir(), 'ours-association-defaults-'));
const defaultsState = join(defaultsHome, '.ours');
const defaultsConfig = join(defaultsState, 'config.json');
const defaultsRegistryPath = join(defaultsHome, 'profiles.json');
mkdirSync(defaultsState, { recursive: true });
const defaultsRegistry = {
  version: 1,
  profiles: {
    default: {
      label: 'Default', host: '127.0.0.1', port: 3050, configPath: defaultsConfig,
      stateDir: defaultsState, serviceName: '',
      ownership: { config: false, service: false, state: false },
    },
  },
  harnessAssociations: { codex: 'default' },
};
writeFileSync(defaultsRegistryPath, JSON.stringify(defaultsRegistry));
const defaultsEnv = { HOME: defaultsHome, OURS_INSTALL_PROFILES: defaultsRegistryPath };
for (const [label, configText] of [
  ['numeric string', JSON.stringify({ port: '4999', stateDir: { path: '/wrong' } })],
  ['NaN string', JSON.stringify({ port: 'NaN', stateDir: 42 })],
  ['infinite string', JSON.stringify({ port: 'Infinity', stateDir: false })],
  ['overflowing JSON number', '{"port":1e999,"stateDir":null}'],
  ['null', JSON.stringify({ port: null, stateDir: null })],
  ['object', JSON.stringify({ port: { value: 4999 }, stateDir: { path: '/wrong' } })],
  ['array', JSON.stringify({ port: [4999], stateDir: ['/wrong'] })],
  ['boolean', JSON.stringify({ port: true, stateDir: true })],
  ['empty string port', JSON.stringify({ port: '', stateDir: 0 })],
  ['omitted', '{}'],
]) {
  writeFileSync(defaultsConfig, configText);
  const resolved = resolveRuntimeAssociation('codex', defaultsEnv, defaultsHome);
  assert.equal(resolved.profile.port, 3050, `${label}: wrong-typed port uses the runtime default`);
  assert.equal(resolved.profile.stateDir, defaultsState, `${label}: wrong-typed stateDir uses the runtime default`);
}
console.log('  ✓ association ignores the same wrong-typed endpoint fields as runtime config loading');

for (const [label, config] of [
  ['finite numeric port drift', { port: 4999, stateDir: defaultsState }],
  ['string state drift', { port: 3050, stateDir: join(defaultsHome, 'wrong-state') }],
  ['empty string state drift', { port: 3050, stateDir: '' }],
]) {
  writeFileSync(defaultsConfig, JSON.stringify(config));
  assert.throws(
    () => resolveRuntimeAssociation('codex', defaultsEnv, defaultsHome),
    (error) => error instanceof AssociationError && error.code === 'CONFIG_DRIFT' && /profile default expects/.test(error.message),
    `${label} remains a structured fail-closed error`,
  );
}
console.log('  ✓ association preserves structured errors for real finite-number/string drift');

const collision = structuredClone(registry);
collision.profiles.green = {
  ...collision.profiles.blue,
  label: 'Green', configPath: join(home, 'green.json'), stateDir: join(home, '.ours-green'), serviceName: 'green',
};
writeFileSync(join(home, 'green.json'), JSON.stringify({ port: 3060, stateDir: join(home, '.ours-green') }));
writeFileSync(registryPath, JSON.stringify(collision));
assert.throws(() => resolveRuntimeAssociation('codex', env, home), (e) => e.code === 'PROFILE_COLLISION');
writeFileSync(registryPath, JSON.stringify(registry));

const calls = [];
const response = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
await verifyRuntimeAssociation(selected, { port: 3060, stateDir }, 'selected-secret', {
  fetch: async (url, options = {}) => {
    calls.push({ url, headers: options.headers });
    if (url.endsWith('/info')) return response(200, { name: 'ours', stateDir });
    return response(200, { identities: [] });
  },
});
assert.equal(calls[0].url.endsWith('/info'), true);
assert.equal(calls[0].headers, undefined, '/info is checked before protected auth');
assert.deepEqual(calls[1].headers, { 'x-ours-api-token': 'selected-secret' });
console.log('  ✓ runtime verifies /info state before protected auth');

await assert.rejects(
  verifyRuntimeAssociation(selected, { port: 3060, stateDir }, 'do-not-print', {
    fetch: async (url) => url.endsWith('/info')
      ? response(200, { name: 'ours', stateDir: join(home, 'wrong') })
      : response(200, {}),
  }),
  (e) => e.code === 'DAEMON_DRIFT' && !e.message.includes('do-not-print'),
);
await assert.rejects(
  verifyRuntimeAssociation(selected, { port: 3060, stateDir }, 'do-not-print', {
    fetch: async (url) => url.endsWith('/info')
      ? response(200, { name: 'ours', stateDir })
      : response(401, {}),
  }),
  (e) => e.code === 'AUTH_FAILED' && /Re-run the Nightly installer/.test(e.message) && !e.message.includes('do-not-print'),
);
console.log('  ✓ daemon-state drift and protected auth failure are redacted and fail closed');

for (const command of ['start', 'stop', 'restart', 'status', 'install-service', 'uninstall-service', 'serve']) {
  assert.throws(
    () => assertApplicationCommand('codex', command),
    (e) => e.code === 'APPLICATION_NOT_ALLOWED' && /legal only for client commands proxy and watch/.test(e.message),
  );
}
console.log('  ✓ lifecycle commands reject --application before acting');

console.log('\nassociation: all passed');
