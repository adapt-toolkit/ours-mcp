// ours-install v3 stage 1 — argument handling and daemon detection (spec §§1-3).
// Pure: the probe, the file reads and the port check are injected, so nothing
// here opens a socket, starts a daemon or touches a real state directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import {
  parseInstallArgs, InstallUsageError, candidatePort, classifyProbe, findDaemon,
  resolveTarget, searchFreePort, samePath,
  INSTALL_DEFAULT_PORT, INSTALL_RESERVED_PORTS, CLI_PID_RECORD, DAEMON_CONFIG,
} from '../lib/target.mjs';

const HOME = '/home/me';
const OURS = resolve(HOME, '.ours');
const TG = resolve(HOME, '.ours-tg');

// A file layer: { '/abs/path': object }. Anything not listed is absent.
const files = (map) => (path) => (Object.prototype.hasOwnProperty.call(map, path) ? map[path] : null);
// A network: { port: {ok:true, stateDir} | {ok:false, reason} }. Unlisted → nothing answers.
const net = (map) => (port) => map[port] ?? { ok: false, reason: 'connection refused' };
const nothingTaken = () => false;

// ---------------------------------------------------------------- arguments --

test('parseInstallArgs: defaults are ~/.ours and no explicit port', () => {
  const a = parseInstallArgs([], {}, { home: HOME });
  assert.equal(a.stateDir, OURS);
  assert.equal(a.port, null);
  assert.equal(a.portExplicit, false, 'not given must stay distinguishable from given');
  assert.equal(a.dryRun, false);
  assert.equal(a.assumeYes, false);
});

test('parseInstallArgs: --state-dir and --port are resolved and echoed back', () => {
  // Note: the SHELL expands ~, not Node — a literal "~/x" would resolve against
  // the cwd, so the installer never sees one in practice and does not special-case it.
  const a = parseInstallArgs(['--state-dir', `${HOME}/x/../.ours-tg`, '--port', '3051'], {}, { home: HOME });
  assert.equal(a.stateDir, TG, 'relative segments are resolved before anything else sees them');
  assert.equal(a.port, 3051);
  assert.equal(a.portExplicit, true);
  const b = parseInstallArgs([`--state-dir=${TG}`, '--port=3060'], {}, { home: HOME });
  assert.equal(b.stateDir, TG);
  assert.equal(b.port, 3060);
});

test('parseInstallArgs: env carries dry-run and assume-yes; --dry-run also sets it', () => {
  assert.equal(parseInstallArgs([], { OURS_INSTALL_DRY_RUN: '1' }, { home: HOME }).dryRun, true);
  assert.equal(parseInstallArgs([], { OURS_ASSUME_YES: '1' }, { home: HOME }).assumeYes, true);
  assert.equal(parseInstallArgs(['--dry-run'], {}, { home: HOME }).dryRun, true);
});

test('parseInstallArgs: bad input is refused, never guessed', () => {
  const bad = [
    [['--nope'], /unknown option: --nope/],
    [['--state-dir'], /--state-dir requires a value/],
    [['--port'], /--port requires a value/],
    [['--port', 'abc'], /--port must be an integer/],
    [['--port', '0'], /--port must be between 1 and 65535/],
    [['--port', '70000'], /--port must be between 1 and 65535/],
    [['--dry-run=1'], /--dry-run does not take a value/],
    [['--port', '1', '--port', '2'], /--port may be given only once/],
  ];
  for (const [argv, re] of bad) {
    assert.throws(() => parseInstallArgs(argv, {}, { home: HOME }), (e) => {
      assert.ok(e instanceof InstallUsageError, `${argv.join(' ')} must be a usage error`);
      assert.equal(e.exitCode, 2, 'every refusal exits 2');
      assert.match(e.message, re);
      return true;
    }, argv.join(' '));
  }
});

test('parseInstallArgs: -h and -V alias --help and --version', () => {
  assert.equal(parseInstallArgs(['-h'], {}, { home: HOME }).help, true);
  assert.equal(parseInstallArgs(['-V'], {}, { home: HOME }).version, true);
});

// ------------------------------------------------------------------- lookup --

test('samePath compares lexically, after normalisation', () => {
  assert.ok(samePath('/a/b', '/a/./c/../b'));
  assert.ok(!samePath('/a/b', '/a/c'));
  assert.ok(!samePath('/a/b', ''));
});

test('candidatePort: the directory\'s own record, else the default', () => {
  assert.equal(candidatePort({ port: 3060 }), 3060);
  assert.equal(candidatePort({}), INSTALL_DEFAULT_PORT);
  assert.equal(candidatePort(null), INSTALL_DEFAULT_PORT);
  assert.equal(candidatePort({ port: 'nope' }), INSTALL_DEFAULT_PORT, 'a junk value is not a record');
});

test('classifyProbe: present / foreign / absent', () => {
  assert.equal(classifyProbe({ ok: true, stateDir: OURS }, OURS).kind, 'present');
  assert.equal(classifyProbe({ ok: true, stateDir: `${HOME}/./.ours` }, OURS).kind, 'present', 'compared after normalisation');
  assert.equal(classifyProbe({ ok: true, stateDir: TG }, OURS).kind, 'foreign');
  assert.equal(classifyProbe({ ok: true }, OURS).kind, 'foreign', 'answered but not an ours daemon');
  assert.equal(classifyProbe({ ok: false, reason: 'refused' }, OURS).kind, 'absent');
});

test('findDaemon: the recorded port is probed first', () => {
  const found = findDaemon({
    stateDir: OURS,
    readJson: files({ [join(OURS, DAEMON_CONFIG)]: { port: 3060 } }),
    probe: net({ 3060: { ok: true, stateDir: OURS } }),
  });
  assert.equal(found.kind, 'present');
  assert.equal(found.port, 3060);
  assert.equal(found.via, 'config');
});

test('findDaemon: a hand-started daemon with NO recorded port is still found via ours-cli-daemon.json', () => {
  // The corruption case this guard exists for: config.json records nothing, the
  // probe of 3050 misses, and without the PID record the caller would create a
  // SECOND daemon on the SAME state directory.
  const found = findDaemon({
    stateDir: OURS,
    readJson: files({ [join(OURS, CLI_PID_RECORD)]: { port: 3060, stateDir: OURS } }),
    probe: net({ 3060: { ok: true, stateDir: OURS } }),
  });
  assert.equal(found.kind, 'present', 'a daemon reporting this state dir on ANY known port is present');
  assert.equal(found.port, 3060);
  assert.equal(found.via, 'pid-record');
});

test('findDaemon: a PID record whose port does not answer is stale, not present', () => {
  const found = findDaemon({
    stateDir: OURS,
    readJson: files({ [join(OURS, CLI_PID_RECORD)]: { port: 3060 } }),
    probe: net({}),
  });
  assert.equal(found.kind, 'absent');
  assert.equal(found.stalePidRecord, 3060, 'the caller can say WHY it is creating a daemon');
});

test('findDaemon: a foreign daemon on the PID record port does not block the run', () => {
  const found = findDaemon({
    stateDir: OURS,
    readJson: files({ [join(OURS, CLI_PID_RECORD)]: { port: 3060 } }),
    probe: net({ 3060: { ok: true, stateDir: TG } }),
  });
  assert.equal(found.kind, 'absent', 'someone else on a stale record port says nothing about OUR daemon');
});

// ------------------------------------------------------- the derived-port rule --

const target = (over = {}) => resolveTarget({
  stateDir: OURS, probe: net({}), readJson: files({}), isTaken: nothingTaken, ...over,
});

test('present + no --port: the daemon\'s own port is used, silently', () => {
  const r = target({
    readJson: files({ [join(OURS, DAEMON_CONFIG)]: { port: 3060 } }),
    probe: net({ 3060: { ok: true, stateDir: OURS } }),
  });
  assert.equal(r.action, 'update');
  assert.equal(r.port, 3060);
});

test('present + agreeing --port: proceeds', () => {
  const r = target({
    port: 3060, portExplicit: true,
    readJson: files({ [join(OURS, DAEMON_CONFIG)]: { port: 3060 } }),
    probe: net({ 3060: { ok: true, stateDir: OURS } }),
  });
  assert.equal(r.action, 'update');
  assert.equal(r.port, 3060);
});

test('present + disagreeing --port: REFUSED, exit 2, nothing written', () => {
  const r = target({
    port: 3999, portExplicit: true,
    readJson: files({ [join(OURS, DAEMON_CONFIG)]: { port: 3060 } }),
    probe: net({ 3060: { ok: true, stateDir: OURS } }),
  });
  assert.equal(r.action, 'refuse');
  assert.equal(r.exitCode, 2);
  assert.equal(r.reason, 'port-mismatch');
  assert.match(r.message, /--port 3999 disagrees with port 3060/);
  assert.match(r.message, new RegExp(OURS.replace(/[.]/g, '\\.')), 'the message names the real daemon');
});

test('a foreign daemon on the candidate port: REFUSED, exit 2, and it names the other directory', () => {
  const r = target({ probe: net({ [INSTALL_DEFAULT_PORT]: { ok: true, stateDir: TG } }) });
  assert.equal(r.action, 'refuse');
  assert.equal(r.exitCode, 2);
  assert.equal(r.reason, 'foreign-daemon');
  assert.equal(r.otherStateDir, TG);
  assert.match(r.message, /owns state directory .*\.ours-tg, not .*\.ours/);
});

test('something that is not an ours daemon on the candidate port: also REFUSED', () => {
  const r = target({ probe: net({ [INSTALL_DEFAULT_PORT]: { ok: true } }) });
  assert.equal(r.action, 'refuse');
  assert.equal(r.reason, 'foreign-daemon');
  assert.match(r.message, /not an ours daemon/);
});

test('absent + no --port: a free port is searched from 3050, skipping reserved defaults', () => {
  const r = target({ isTaken: (p) => p === 3050 });
  assert.equal(r.action, 'create');
  assert.equal(r.port, 3053, 'skips 3051 (tg) and 3052 (cowork)');
  assert.deepEqual(INSTALL_RESERVED_PORTS, [3051, 3052]);
});

test('absent + explicit --port: used exactly as typed and NEVER moved', () => {
  const r = target({ port: 3051, portExplicit: true });
  assert.equal(r.action, 'create');
  assert.equal(r.port, 3051, "the owner's `--port 3051` must keep working");
  assert.equal(r.reservedNotice, 3051, 'but the operator is told it is the connector default');
});

test('absent + explicit --port that is occupied: REFUSED rather than shifted', () => {
  const r = target({ port: 3060, portExplicit: true, isTaken: (p) => p === 3060 });
  assert.equal(r.action, 'refuse');
  assert.equal(r.exitCode, 2);
  assert.equal(r.reason, 'port-occupied');
});

test('creating after a stale PID record reports why', () => {
  const r = target({ readJson: files({ [join(OURS, CLI_PID_RECORD)]: { port: 3060 } }) });
  assert.equal(r.action, 'create');
  assert.equal(r.stalePidRecord, 3060);
});

test('a re-run with the same state dir can never reach the foreign-daemon refusal', () => {
  // The owner's correction: the directory is looked up first and its own daemon
  // is found on its own port, so an auto-picked port is never in play on a re-run.
  const readJson = files({ [join(OURS, DAEMON_CONFIG)]: { port: 3060 } });
  const probe = net({ 3060: { ok: true, stateDir: OURS }, [INSTALL_DEFAULT_PORT]: { ok: true, stateDir: TG } });
  const r = resolveTarget({ stateDir: OURS, probe, readJson, isTaken: nothingTaken });
  assert.equal(r.action, 'update');
  assert.equal(r.port, 3060, 'the stranger on 3050 is never consulted');
});

test('searchFreePort: returns null instead of looping or reusing a bound port', () => {
  assert.equal(searchFreePort(() => true, { span: 5 }), null);
});

test('an exhausted free-port band REFUSES rather than widening or reusing', () => {
  const r = target({ isTaken: () => true });
  assert.equal(r.action, 'refuse');
  assert.equal(r.exitCode, 2);
  assert.equal(r.reason, 'no-free-port');
  assert.deepEqual(r.searched, { from: 3050, to: 4049 }, 'the message names the band it searched');
  assert.match(r.message, /pass --port explicitly/);
});
