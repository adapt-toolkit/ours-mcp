// Named boot-service instances: the naming/validation contract that lets a
// deliberately isolated second daemon persist WITHOUT overwriting the shared
// one's unit. The default (no name) must stay byte-identical to what shipped
// before this existed — that backward compatibility is the whole risk here.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_SYSTEMD_UNIT,
  DEFAULT_LAUNCHD_LABEL,
  normalizeInstanceName,
  systemdUnitName,
  launchdLabel,
  buildSystemdUnit,
  buildLaunchdPlist,
} from '../dist/service-instance.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'dist', 'cli.js');

function parsePlistString(plist, key) {
  const startMarker = `<key>${key}</key><string>`;
  const start = plist.indexOf(startMarker);
  assert.notEqual(start, -1, `plist contains ${key}`);
  const valueStart = start + startMarker.length;
  const valueEnd = plist.indexOf('</string>', valueStart);
  assert.notEqual(valueEnd, -1, `plist closes ${key}'s string value`);
  return plist.slice(valueStart, valueEnd).replace(/&(?:amp|lt|gt|quot|apos);|[&<]/g, (entity) => {
    const decoded = {
      '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
    }[entity];
    assert.notEqual(decoded, undefined, `plist contains only well-formed XML text in ${key}`);
    return decoded;
  });
}

console.log('service-instance\n');

// ---- backward compatibility: no name ⇒ exactly the historical definition ----
assert.equal(systemdUnitName(), 'ours.service');
assert.equal(systemdUnitName(''), 'ours.service');
assert.equal(systemdUnitName('   '), 'ours.service');
assert.equal(systemdUnitName(undefined), 'ours.service');
assert.equal(DEFAULT_SYSTEMD_UNIT, 'ours.service');
assert.equal(launchdLabel(), 'solutions.adaptframework.ours');
assert.equal(launchdLabel(''), 'solutions.adaptframework.ours');
assert.equal(DEFAULT_LAUNCHD_LABEL, 'solutions.adaptframework.ours');
console.log('  ✓ unnamed daemon keeps ours.service / solutions.adaptframework.ours');

// ---- named instances get their OWN definition ------------------------------
assert.equal(systemdUnitName('tg'), 'ours-tg.service');
assert.equal(systemdUnitName('rooms'), 'ours-rooms.service');
assert.equal(launchdLabel('tg'), 'solutions.adaptframework.ours.tg');
// The collision this feature exists to prevent: a named unit can never BE the
// shared unit, and two names can never be the same unit.
assert.notEqual(systemdUnitName('tg'), DEFAULT_SYSTEMD_UNIT);
assert.notEqual(systemdUnitName('tg'), systemdUnitName('rooms'));
assert.notEqual(launchdLabel('tg'), DEFAULT_LAUNCHD_LABEL);
assert.notEqual(launchdLabel('tg'), launchdLabel('rooms'));
console.log('  ✓ named instances are distinct from the shared unit and from each other');

// ---- validation: refused, never silently rewritten -------------------------
assert.deepEqual(normalizeInstanceName('tg'), { ok: true, name: 'tg' });
assert.deepEqual(normalizeInstanceName('  tg  '), { ok: true, name: 'tg' }, 'surrounding space trimmed');
assert.equal(normalizeInstanceName('a-b_c9').ok, true);
assert.equal(normalizeInstanceName('').ok, true, 'empty is the valid "shared daemon" selection');
for (const bad of [
  'has space', 'has/slash', '../escape', 'dot.separated', '-leading', 'trailing-',
  'nul\u0000byte', 'new\nline', 'car\rriage', 'tab\tchar', 'a'.repeat(33), '@at', 'ours.service',
]) {
  const v = normalizeInstanceName(bad);
  assert.equal(v.ok, false, `must reject ${JSON.stringify(bad)}`);
  assert.equal(v.name, '', 'a rejected name never yields a usable name');
  assert.match(v.reason, /service name/, 'reports why');
}
// A rejected name must NOT quietly become the shared unit at the naming layer
// either — callers gate on normalizeInstanceName().ok first (cli.ts does).
assert.equal(normalizeInstanceName('has space').ok, false);
console.log('  ✓ invalid names are rejected with a reason, never sanitized into a unit');

// ---- unit text: the baked environment is what isolates two daemons ---------
const shared = buildSystemdUnit({
  port: 3050, brokerUrl: 'wss://broker1.ours.network', stateDir: '/home/u/.ours',
  execPath: '/usr/bin/node', self: '/opt/ours/cli.js',
});
const dedicated = buildSystemdUnit({
  instance: 'tg', configPath: '/home/u/.ours-tg/config.json', port: 3060,
  brokerUrl: 'wss://broker1.ours.network', stateDir: '/home/u/.ours-tg',
  execPath: '/usr/bin/node', self: '/opt/ours/cli.js',
});
assert.doesNotMatch(shared, /OURS_SERVICE_NAME/, 'the shared unit is unchanged — no new env leaks in');
assert.doesNotMatch(shared, /OURS_CONFIG/, 'the shared unit keeps its historical implicit config path');
assert.match(shared, /^Description=ours MCP daemon \(secure agent-to-agent messaging over ADAPT\)$/m);
assert.match(shared, /^Environment=OURS_PORT=3050$/m);
assert.match(shared, /^Environment=OURS_STATE_DIR=\/home\/u\/\.ours$/m);
assert.match(dedicated, /^Environment=OURS_SERVICE_NAME=tg$/m);
assert.match(dedicated, /^Environment=OURS_CONFIG=\/home\/u\/\.ours-tg\/config\.json$/m);
assert.match(dedicated, /^Environment=OURS_PORT=3060$/m);
assert.match(dedicated, /^Environment=OURS_STATE_DIR=\/home\/u\/\.ours-tg$/m);
assert.match(dedicated, /instance "tg"/, 'the description says which daemon this is');
// Neither definition can be mistaken for the other.
assert.notEqual(shared, dedicated);
assert.match(shared, /^Restart=on-failure$/m, 'restart policy intact with no instance line');
assert.match(dedicated, /^Restart=on-failure$/m, 'restart policy intact after the instance line');
assert.match(shared, /^\[Install\]\nWantedBy=default\.target$/m);

const plistShared = buildLaunchdPlist({
  port: 3050, brokerUrl: 'wss://b', stateDir: '/s', execPath: '/n', self: '/c', logPath: '/l',
});
const plistSharedWithUnusedConfig = buildLaunchdPlist({
  configPath: '/ignored/profile&auth/config.json',
  port: 3050, brokerUrl: 'wss://b', stateDir: '/s', execPath: '/n', self: '/c', logPath: '/l',
});
const plistDedicated = buildLaunchdPlist({
  instance: 'rooms', configPath: '/cfg/rooms.json', port: 3062,
  brokerUrl: 'wss://b', stateDir: '/s2', execPath: '/n', self: '/c', logPath: '/l',
});
assert.match(plistShared, /<key>Label<\/key><string>solutions\.adaptframework\.ours<\/string>/);
assert.doesNotMatch(plistShared, /OURS_SERVICE_NAME/);
assert.doesNotMatch(plistShared, /OURS_CONFIG/);
assert.equal(plistSharedWithUnusedConfig, plistShared,
  'an unnamed launchd definition stays byte-identical and never persists OURS_CONFIG');
assert.match(plistDedicated, /<key>Label<\/key><string>solutions\.adaptframework\.ours\.rooms<\/string>/);
assert.match(plistDedicated, /<key>OURS_SERVICE_NAME<\/key><string>rooms<\/string>/);
assert.match(plistDedicated, /<key>OURS_CONFIG<\/key><string>\/cfg\/rooms\.json<\/string>/);
console.log('  ✓ named unit/plist bake the exact config, instance, port, and state dir');

const specialConfigPath = `/tmp/profile&auth<nightly>"quote"'apostrophe/config.json`;
const plistSpecial = buildLaunchdPlist({
  instance: 'special', configPath: specialConfigPath, port: 3063,
  brokerUrl: 'wss://b', stateDir: '/safe-state', execPath: '/n', self: '/c', logPath: '/l',
});
assert.equal(parsePlistString(plistSpecial, 'OURS_CONFIG'), specialConfigPath,
  'plist parsing recovers the exact special-character config path');
console.log('  ✓ named launchd config paths are valid XML and round-trip exactly');

// ---- determinism / idempotency: same input ⇒ byte-identical definition ------
assert.equal(
  buildSystemdUnit({ instance: 'tg', configPath: '/c/tg.json', port: 3060, brokerUrl: 'wss://b', stateDir: '/s', execPath: '/n', self: '/c' }),
  buildSystemdUnit({ instance: 'tg', configPath: '/c/tg.json', port: 3060, brokerUrl: 'wss://b', stateDir: '/s', execPath: '/n', self: '/c' }),
  're-running install-service with the same selection rewrites the same bytes',
);
console.log('  ✓ definition generation is deterministic (safe rerun)');

// ---- CLI: an invalid instance name FAILS the service commands --------------
// Only the rejection path is driven here: it exits before touching systemd or
// launchd, so this stays hermetic on a real machine.
const tmp = mkdtempSync(join(tmpdir(), 'ours-service-instance-'));
let subprocessBlocked = false;
try {
  const cfg = join(tmp, 'config.json');
  writeFileSync(cfg, JSON.stringify({ port: 3099, stateDir: join(tmp, 'state') }) + '\n');
  for (const cmd of ['install-service', 'uninstall-service']) {
    const r = spawnSync(process.execPath, [CLI, cmd], {
      env: { ...process.env, OURS_CONFIG: cfg, OURS_SERVICE_NAME: 'not a name', OURS_STATE_DIR: join(tmp, 'state') },
      encoding: 'utf8',
    });
    if (r.error?.code === 'EPERM') {
      subprocessBlocked = true;
      console.log('  ⊘ CLI subprocess assertions blocked by sandbox spawnSync EPERM');
      break;
    }
    assert.equal(r.status, 1, `${cmd} refuses an invalid instance name`);
    assert.match(r.stderr, /invalid service name/, `${cmd} says what is wrong`);
    assert.match(r.stderr, /OURS_SERVICE_NAME/, `${cmd} says how to fix it`);
  }
  if (!subprocessBlocked) {
    // And it never wrote a unit anywhere while refusing.
    const unitDir = join(homedir(), '.config', 'systemd', 'user');
    let listing = [];
    try { listing = readdirSync(unitDir); } catch { /* no systemd dir on this host */ }
    assert.ok(!listing.includes('ours-not a name.service'), 'no unit written for a rejected name');
    console.log('  ✓ install/uninstall-service refuse an invalid instance name (exit 1, nothing written)');
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// ---- config plumbing: env beats file, file works alone ---------------------
const tmp2 = mkdtempSync(join(tmpdir(), 'ours-service-cfg-'));
try {
  mkdirSync(join(tmp2, 'state'), { recursive: true });
  const cfg = join(tmp2, 'config.json');
  writeFileSync(cfg, JSON.stringify({ port: 3099, stateDir: join(tmp2, 'state'), serviceName: 'fromfile' }) + '\n');
  // `help` loads the config without touching the daemon; an invalid ENV name
  // would only surface on a service command, so drive uninstall-service and read
  // the failure text to prove which source won.
  if (!subprocessBlocked) {
    const r = spawnSync(process.execPath, [CLI, 'uninstall-service'], {
      env: { ...process.env, OURS_CONFIG: cfg, OURS_SERVICE_NAME: 'bad name', OURS_STATE_DIR: join(tmp2, 'state') },
      encoding: 'utf8',
    });
    assert.equal(r.status, 1, 'the ENV name is what gets validated');
    assert.match(r.stderr, /"bad name"/, 'env overrides the config file');
    console.log('  ✓ OURS_SERVICE_NAME overrides config.json serviceName');
  }
} finally {
  rmSync(tmp2, { recursive: true, force: true });
}

console.log('\nservice-instance: all passed');
