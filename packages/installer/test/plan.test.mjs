// ours-install v3 stage 2 — daemon creation and boot-service installation
// (spec §§3-4). Pure: file reads are injected. NOTHING here installs, enables or
// starts a service, and no systemctl is invoked in any path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import {
  unitNameForStateDir, unitPathForStateDir, classifyUnit, planServiceInstall,
  serviceInstallCommand, planDaemonConfig, planDaemonSteps,
  CLI_UNIT_MARKER, DEFAULT_SYSTEMD_UNIT,
} from '../lib/plan.mjs';

const HOME = '/home/me';
const OURS = resolve(HOME, '.ours');
const TG = resolve(HOME, '.ours-tg');
const unitPath = (name) => join(HOME, '.config', 'systemd', 'user', name);
const texts = (map) => (path) => (Object.prototype.hasOwnProperty.call(map, path) ? map[path] : null);

// The unit ours-mcp v0.16.0 actually writes: no marker, first line "[Unit]".
const LEGACY_UNIT = `[Unit]
Description=ours MCP daemon (secure agent-to-agent messaging over ADAPT)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/node /usr/local/lib/node_modules/@ours.network/mcp/dist/cli.js serve
Environment=OURS_TRANSPORT=http
Environment=OURS_PORT=3050
Environment=OURS_BROKER_URL=wss://broker1.ours.network
Environment=OURS_STATE_DIR=${OURS}
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`;

const CLI_UNIT = `${CLI_UNIT_MARKER}
[Unit]
Description=ours shared daemon
`;

// --------------------------------------------------------- unit derivation --

test('unitNameForStateDir: the table must match ours-sdk service-instance.ts', () => {
  assert.deepEqual(unitNameForStateDir(OURS), { ok: true, unit: DEFAULT_SYSTEMD_UNIT, instance: '' });
  assert.equal(unitNameForStateDir(TG).unit, 'ours-tg.service');
  assert.equal(unitNameForStateDir('/srv/ours-tg').unit, 'ours-tg.service');
  assert.equal(unitNameForStateDir('/srv/mydaemon').unit, 'ours-mydaemon.service');
  assert.equal(unitNameForStateDir('/srv/./a/../ours-b').unit, 'ours-b.service', 'resolved before the segment is taken');
  const bad = unitNameForStateDir('/srv/a.b');
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /does not yield a usable service name/);
  assert.equal(unitNameForStateDir(`/srv/ours-${'x'.repeat(33)}`).ok, false, 'the 32-character bound applies');
});

test('unitPathForStateDir puts it in the systemd user directory', () => {
  assert.equal(unitPathForStateDir(TG, HOME).path, unitPath('ours-tg.service'));
});

// ------------------------------------------------------- unit classification --

test('classifyUnit: absent / cli-managed / legacy / foreign', () => {
  assert.equal(classifyUnit(null).kind, 'absent');
  assert.equal(classifyUnit(CLI_UNIT).kind, 'cli-managed');
  assert.equal(classifyUnit(LEGACY_UNIT).kind, 'legacy', "published ours-mcp's unit is recognisable");
  assert.equal(classifyUnit('[Unit]\nDescription=something a sysadmin wrote\n').kind, 'foreign');
});

test('classifyUnit: an unmarked unit that is not ours-mcp is never called legacy', () => {
  // The distinction that matters: we may name the one command for a file we can
  // identify, and must not offer to remove one we cannot.
  const other = '[Unit]\nDescription=my own thing\n[Service]\nExecStart=/usr/bin/ours-something-else\n';
  assert.equal(classifyUnit(other).kind, 'foreign');
});

// ------------------------------------------------------------ service plan --

test('planServiceInstall: nothing in the way → install, and the CLI names the unit', () => {
  const p = planServiceInstall({ stateDir: TG, home: HOME, readText: texts({}) });
  assert.equal(p.action, 'install');
  assert.equal(p.unit, 'ours-tg.service');
  assert.equal(p.instance, 'tg');
});

test('planServiceInstall: an existing CLI-managed unit is not special-cased', () => {
  const p = planServiceInstall({ stateDir: OURS, home: HOME, readText: texts({ [unitPath('ours.service')]: CLI_UNIT }) });
  assert.equal(p.action, 'install', 'the CLI owns idempotence and the baked-state-dir guard from here');
});

test('planServiceInstall: the legacy ours-mcp unit is the migration blocker, handled deliberately', () => {
  const p = planServiceInstall({ stateDir: OURS, home: HOME, readText: texts({ [unitPath('ours.service')]: LEGACY_UNIT }) });
  assert.equal(p.action, 'migrate-unit');
  assert.deepEqual(p.command, ['ours-mcp', 'uninstall-service']);
  assert.match(p.message, /written by an older ours-mcp/);
  assert.match(p.message, /will not overwrite a unit it does not manage/);
});

test('planServiceInstall NEVER passes --force, in any outcome', () => {
  for (const text of [null, CLI_UNIT, LEGACY_UNIT, '[Unit]\nDescription=stranger\n']) {
    const p = planServiceInstall({ stateDir: OURS, home: HOME, readText: texts({ [unitPath('ours.service')]: text }) });
    assert.ok(!JSON.stringify(p).includes('--force'), 'the guard is never bypassed on the user\'s behalf');
  }
  assert.ok(!serviceInstallCommand({ stateDir: OURS }).includes('--force'));
});

test('planServiceInstall: non-interactive turns the legacy case into a refusal, not a silent removal', () => {
  // OURS_ASSUME_YES suppresses questions; it never suppresses a refusal (spec §9).
  const p = planServiceInstall({ stateDir: OURS, home: HOME, assumeYes: true, readText: texts({ [unitPath('ours.service')]: LEGACY_UNIT }) });
  assert.equal(p.action, 'refuse');
  assert.equal(p.exitCode, 2);
  assert.equal(p.reason, 'legacy-unit-needs-consent');
  assert.match(p.message, /Run `ours-mcp uninstall-service` and re-run/);
});

test('planServiceInstall: an unidentifiable unit stops the run and is never removed', () => {
  const p = planServiceInstall({ stateDir: OURS, home: HOME, readText: texts({ [unitPath('ours.service')]: '[Unit]\nDescription=stranger\n' }) });
  assert.equal(p.action, 'refuse');
  assert.equal(p.exitCode, 2);
  assert.equal(p.reason, 'unknown-unit');
  assert.match(p.message, /Refusing to touch it/);
  assert.ok(!p.command, 'no command is offered for a file we cannot identify');
});

test('planServiceInstall: a state dir with no usable name refuses instead of guessing', () => {
  const p = planServiceInstall({ stateDir: '/srv/a.b', home: HOME, readText: texts({}) });
  assert.equal(p.action, 'refuse');
  assert.equal(p.reason, 'unusable-state-dir');
});

test('serviceInstallCommand selects the daemon and lets the CLI name the unit', () => {
  const cmd = serviceInstallCommand({ stateDir: TG });
  assert.deepEqual(cmd, ['ours', 'daemon', 'install-service', '--yes', '--state-dir', TG, '--config', join(TG, 'config.json')]);
  assert.ok(!cmd.some((a) => /\.service$/.test(a)), 'no unit name is passed — one derivation, in the CLI');
});

// ------------------------------------------------------------- config merge --

test('planDaemonConfig merges and preserves every unrelated key', () => {
  const existing = { port: 3050, apiVisibility: 'shared', stt: { provider: 'x' }, gcIntervalMs: 42 };
  const p = planDaemonConfig(existing, { port: 3051, stateDir: TG, brokerUrl: 'wss://b' });
  assert.equal(p.changed, true);
  assert.deepEqual(p.changes.sort(), ['brokerUrl', 'port', 'stateDir']);
  assert.equal(p.config.apiVisibility, 'shared');
  assert.deepEqual(p.config.stt, { provider: 'x' });
  assert.equal(p.config.gcIntervalMs, 42);
  assert.equal(p.config.stateDir, TG, 'absolute, and always written with the port');
  assert.match(p.text, /\n$/);
});

test('planDaemonConfig: a merge that changes nothing does not touch the file', () => {
  const same = { port: 3050, stateDir: OURS, brokerUrl: 'wss://b', apiToken: 'keep' };
  const p = planDaemonConfig(same, { port: 3050, stateDir: OURS, brokerUrl: 'wss://b' });
  assert.equal(p.changed, false);
  assert.deepEqual(p.changes, []);
  assert.equal(p.config.apiToken, 'keep');
});

test('planDaemonConfig tolerates a missing or non-object config', () => {
  for (const junk of [null, undefined, [], 'nope']) {
    const p = planDaemonConfig(junk, { port: 3050, stateDir: OURS, brokerUrl: 'wss://b' });
    assert.equal(p.config.port, 3050);
    assert.equal(p.config.stateDir, OURS);
  }
});

// -------------------------------------------------------------- step order --

test('planDaemonSteps: creating runs CLI → config → start → service, in that order', () => {
  const steps = planDaemonSteps({ action: 'create', stateDir: TG, port: 3051 });
  assert.deepEqual(steps.map((s) => s.id), ['cli', 'config', 'start', 'service']);
  assert.ok(steps.find((s) => s.id === 'start').command.includes(join(TG, 'config.json')));
});

test('planDaemonSteps: updating never starts a daemon and never moves a port', () => {
  const steps = planDaemonSteps({ action: 'update', stateDir: OURS, port: 3050 });
  assert.deepEqual(steps.map((s) => s.id), ['cli', 'config', 'service']);
  assert.ok(!steps.some((s) => s.id === 'start'), 'update never creates a second daemon');
});

test('planDaemonSteps: a version change restarts only a daemon the CLI started', () => {
  const mine = planDaemonSteps({ action: 'update', stateDir: OURS, port: 3050 }, { cliVersionChanged: true, cliStartedIt: true });
  assert.deepEqual(mine.map((s) => s.id), ['cli', 'config', 'restart', 'service']);
  const theirs = planDaemonSteps({ action: 'update', stateDir: OURS, port: 3050 }, { cliVersionChanged: true, cliStartedIt: false });
  const step = theirs.find((s) => s.id === 'restart-external');
  assert.ok(step, '`ours daemon stop` refuses to signal a daemon it did not start');
  assert.equal(step.command, null, 'the screen names the launcher; the installer runs nothing');
});
