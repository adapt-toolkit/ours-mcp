// Unit test for config.ts precedence (env > config.json > default) + writeConfig.
// Run: cd plugin && npx tsx ../test-config.ts

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import {
  loadConfig,
  writeConfig,
  configPath,
  DEFAULT_CONFIG,
  buildIdentityFile,
  writeIdentityFile,
  resolveIdentityFilePath,
  IDENTITY_FILENAME,
} from './plugin/src/config.ts';

const TMP = '/tmp/ours-cfg-test';
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
const cfgPath = resolve(TMP, 'config.json');
process.env.OURS_CONFIG = cfgPath;

const envKeys = ['OURS_BROKER_URL', 'OURS_PORT', 'OURS_STATE_DIR', 'OURS_GC_INTERVAL_MS'];
const clearEnv = () => { for (const k of envKeys) delete process.env[k]; };

let pass = 0;
const ok = (c: boolean, m: string) => { assert.ok(c, m); console.log(`  ✓ ${m}`); pass++; };

console.log('=== config.ts precedence test ===\n');

ok(configPath() === cfgPath, 'configPath() honors OURS_CONFIG');

clearEnv();
fs.rmSync(cfgPath, { force: true });
{
  const c = loadConfig();
  ok(c.brokerUrl === DEFAULT_CONFIG.brokerUrl, 'default brokerUrl (no file, no env)');
  ok(c.port === 3030, 'default port');
  ok(c.stateDir === resolve(homedir(), '.ours'), 'default stateDir');
  ok(c.gcIntervalMs === 3_600_000, 'default gcIntervalMs');
}

clearEnv();
writeConfig({ brokerUrl: 'ws://file-broker:1/b', port: 4040, stateDir: '/tmp/file-state', gcIntervalMs: 1234 });
ok(fs.existsSync(cfgPath), 'writeConfig wrote the file');
ok((fs.statSync(cfgPath).mode & 0o777) === 0o600, 'config.json is mode 0600');
{
  const c = loadConfig();
  ok(c.brokerUrl === 'ws://file-broker:1/b', 'file brokerUrl');
  ok(c.port === 4040, 'file port');
  ok(c.stateDir === '/tmp/file-state', 'file stateDir');
  ok(c.gcIntervalMs === 1234, 'file gcIntervalMs');
}

process.env.OURS_BROKER_URL = 'ws://env-broker:2/b';
process.env.OURS_PORT = '5050';
process.env.OURS_GC_INTERVAL_MS = '9999';
{
  const c = loadConfig();
  ok(c.brokerUrl === 'ws://env-broker:2/b', 'env brokerUrl overrides file');
  ok(c.port === 5050, 'env port overrides file');
  ok(c.gcIntervalMs === 9999, 'env gcIntervalMs overrides file');
  ok(c.stateDir === '/tmp/file-state', 'stateDir still from file (no env set for it)');
}

process.env.OURS_PORT = 'notanumber';
ok(loadConfig().port === 4040, 'non-numeric env port falls back to file (not NaN)');

console.log('\n=== .ours-identity helpers ===\n');

// buildIdentityFile: force omitted when false, exposure always explicit.
{
  const min = buildIdentityFile({ name: 'Alice' });
  ok(min.identity === 'Alice', 'buildIdentityFile sets identity');
  ok(!('force' in min), 'force omitted when not requested');
  ok(min.expose_local === true && min.local_auto_accept === true, 'exposure defaults to true');

  const full = buildIdentityFile({ name: '  Bob  ', force: true, exposeLocal: false, localAutoAccept: false });
  ok(full.identity === 'Bob', 'name is trimmed');
  ok(full.force === true, 'force written when true');
  ok(full.expose_local === false && full.local_auto_accept === false, 'opt-outs honored');

  assert.throws(() => buildIdentityFile({ name: '   ' }), 'empty name rejected');
  console.log('  ✓ empty name rejected');
  pass++;
}

// resolveIdentityFilePath: directory → append filename; explicit file → as-is.
{
  ok(basename(resolveIdentityFilePath('/tmp/x')) === IDENTITY_FILENAME, 'dir target appends filename');
  ok(
    resolveIdentityFilePath(`/tmp/x/${IDENTITY_FILENAME}`) === `/tmp/x/${IDENTITY_FILENAME}`,
    'explicit file path used as-is',
  );
}

// writeIdentityFile: writes, refuses to clobber, overwrites on request.
{
  const dir = resolve(TMP, 'pin');
  fs.rmSync(dir, { recursive: true, force: true });
  const p = writeIdentityFile(dir, { name: 'Carol', force: true });
  ok(p === join(dir, IDENTITY_FILENAME), 'writeIdentityFile returns the path (mkdir -p)');
  ok(JSON.parse(fs.readFileSync(p, 'utf8')).identity === 'Carol', 'file content round-trips');
  assert.throws(() => writeIdentityFile(dir, { name: 'Dave' }), 'refuses to clobber without overwrite');
  console.log('  ✓ refuses to clobber without overwrite');
  pass++;
  writeIdentityFile(dir, { name: 'Dave' }, true);
  ok(JSON.parse(fs.readFileSync(p, 'utf8')).identity === 'Dave', 'overwrite=true replaces the file');
}

console.log(`\n=== CONFIG TEST PASSED (${pass} assertions) ===`);
