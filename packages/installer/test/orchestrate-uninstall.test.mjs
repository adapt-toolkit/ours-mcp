// ours-uninstall v3 — the orchestrator (spec §§8-9).
//
// Every side effect is injected, so this walks whole removals without deleting
// anything, stopping anything, or running a command. NOTHING here touches a real
// state directory, and `removeDir` is a recorder in every test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { runUninstall, runPurgePhase, EXIT_OK, EXIT_REFUSED } from '../lib/orchestrate-uninstall.mjs';

const HOME = '/home/me';
const OURS = resolve(HOME, '.ours');
const TG_CFG = join(HOME, '.ours-telegram', 'config.json');
const COWORK_CFG = join(HOME, '.ours-cowork', 'config.json');

function fx({ json = {}, text = {}, env = {}, answers = [], typed = null, known = [OURS], isStateDir = true, present = () => false } = {}) {
  const recorder = { ran: [], wrote: [], out: [], asked: [], removed: [], wroteText: [] };
  let i = 0;
  return {
    recorder,
    home: HOME,
    env,
    readJson: (p) => (Object.prototype.hasOwnProperty.call(json, p) ? json[p] : null),
    writeJson: (p, body) => { recorder.wrote.push([p, body]); },
    run: async (cmd, a) => { recorder.ran.push([cmd, ...a]); return { ok: true, code: 0, stdout: '' }; },
    removeDir: async (p) => { recorder.removed.push(p); },
    removeFile: async (p) => { recorder.removed.push(p); },
    readText: (p) => (Object.prototype.hasOwnProperty.call(text, p) ? text[p] : null),
    writeText: (p, body) => { recorder.wroteText.push([p, body]); },
    knownStateDirs: () => known,
    // `isStateDir` answers the purge gate; `present` answers "does this plugin
    // file exist", so a test can leave the plugin phase with nothing to do.
    exists: (p) => (String(p).includes('.hermes') || String(p).includes('.codex') || String(p).includes('skills') ? present(p) : isStateDir),
    out: (l) => recorder.out.push(String(l)),
    ask: async (p) => { recorder.asked.push(p); return answers[i++] ?? false; },
    askLine: async (p) => { recorder.asked.push(p); return typed; },
  };
}
const said = (e) => e.recorder.out.join('\n');
const CFG = { port: 3050, stateDir: OURS };

test('NO uninstall path ever runs systemctl', async () => {
  const e = fx({ json: { [join(OURS, 'config.json')]: CFG } });
  await runUninstall(['--state-dir', OURS], e);
  for (const cmd of e.recorder.ran) {
    assert.ok(!cmd.includes('systemctl') && !cmd.includes('loginctl'), `never: ${cmd.join(' ')}`);
  }
});

test('a component still pointing here refuses BEFORE the first mutation', async () => {
  const e = fx({ json: { [join(OURS, 'config.json')]: CFG, [TG_CFG]: { daemonStateDir: OURS, botToken: 's' } } });
  assert.equal(await runUninstall(['--state-dir', OURS], e), EXIT_REFUSED);
  assert.deepEqual(e.recorder.ran, [], 'nothing stopped or removed');
  assert.deepEqual(e.recorder.wrote, []);
  assert.deepEqual(e.recorder.removed, []);
  assert.match(said(e), /still point at this daemon/);
});

test('confirming the component in the same run lets it proceed, and KEEPS the file', async () => {
  const e = fx({
    json: { [join(OURS, 'config.json')]: CFG, [TG_CFG]: { daemonUrl: 'http://127.0.0.1:3050', daemonStateDir: OURS, botToken: 'secret' } },
    answers: [true],
  });
  assert.equal(await runUninstall(['--state-dir', OURS], e), EXIT_OK);
  const [path, body] = e.recorder.wrote.find(([p]) => p === TG_CFG);
  const rewritten = JSON.parse(body);
  assert.equal(path, TG_CFG);
  assert.equal(rewritten.botToken, 'secret', 'the operator bot token was never ours to delete');
  assert.ok(!('daemonUrl' in rewritten) && !('daemonStateDir' in rewritten));
  assert.ok(e.recorder.ran.some((c) => c.join(' ') === 'ours-tg-connector uninstall-service'));
});

test('detaching cowork announces the behaviour change before it happens', async () => {
  const e = fx({
    json: {
      [join(OURS, 'config.json')]: CFG,
      [COWORK_CFG]: { stateDir: '/home/me/.ours-cowork', daemon: { mode: 'external', endpoint: 'http://127.0.0.1:3050', stateDir: OURS } },
    },
    answers: [true],
  });
  await runUninstall(['--state-dir', OURS], e);
  const announced = said(e).indexOf('returns to embedded mode');
  const written = said(e).indexOf('.ours-cowork/config.json');
  assert.ok(announced >= 0, 'the change is stated');
  assert.ok(announced < written, 'and stated BEFORE the file is touched');
});

test('a daemon the CLI did not start is named, not signalled', async () => {
  const e = fx({ json: { [join(OURS, 'config.json')]: CFG } });
  await runUninstall(['--state-dir', OURS], e);
  assert.ok(!e.recorder.ran.some((c) => c.join(' ').includes('daemon stop')), 'no PID record, so no signal');
  assert.match(said(e), /not started by the CLI/);
});

test('a daemon the CLI DID start is stopped through the CLI', async () => {
  const e = fx({ json: { [join(OURS, 'config.json')]: CFG, [join(OURS, 'ours-cli-daemon.json')]: { pid: 1, port: 3050 } } });
  await runUninstall(['--state-dir', OURS], e);
  assert.ok(e.recorder.ran.some((c) => c.join(' ').includes('daemon stop')));
});

test('--dry-run removes, stops and deletes nothing', async () => {
  const e = fx({ json: { [join(OURS, 'config.json')]: CFG }, typed: OURS });
  assert.equal(await runUninstall(['--state-dir', OURS, '--purge', '--dry-run'], e), EXIT_OK);
  assert.deepEqual(e.recorder.ran, []);
  assert.deepEqual(e.recorder.wrote, []);
  assert.deepEqual(e.recorder.removed, [], 'not even under --purge');
  assert.match(said(e), /\[dry-run\] would: delete/);
});

// ------------------------------------------------------------------ --purge --

test('state is kept by default, with the hint', async () => {
  const e = fx({ json: { [join(OURS, 'config.json')]: CFG } });
  await runUninstall(['--state-dir', OURS], e);
  assert.deepEqual(e.recorder.removed, []);
  assert.match(said(e), /state .* kept/);
  assert.match(said(e), /--purge/);
});

test('--purge with a matching typed path deletes exactly that directory', async () => {
  const e = fx({ json: { [join(OURS, 'config.json')]: CFG }, typed: OURS });
  const r = await runPurgePhase({ dir: OURS, purge: true, args: { dryRun: false, assumeYes: false }, effects: e });
  assert.equal(r.purged, true);
  assert.deepEqual(e.recorder.removed, [OURS], 'the exact directory, never a parent');
});

test('--purge with a WRONG typed path keeps the state and does not retry', async () => {
  // A second chance at deleting identity keys is not a kindness.
  for (const wrong of ['y', 'yes', '', `${OURS}/`, '/home/me']) {
    const e = fx({ typed: wrong });
    const r = await runPurgePhase({ dir: OURS, purge: true, args: { dryRun: false, assumeYes: false }, effects: e });
    assert.equal(r.purged, false, `${JSON.stringify(wrong)} must not purge`);
    assert.deepEqual(e.recorder.removed, []);
    assert.equal(e.recorder.asked.length, 1, 'asked once, not in a loop');
  }
});

test('--purge refuses a directory that is not a state directory at all', async () => {
  const e = fx({ typed: OURS, isStateDir: false });
  const r = await runPurgePhase({ dir: OURS, purge: true, args: { dryRun: false, assumeYes: false }, effects: e, config: { port: 3050 } });
  assert.equal(r.purged, false);
  assert.deepEqual(e.recorder.asked, [], 'it is not even asked about');
  assert.match(said(e), /does not look like an ours state directory/);
});

// ---------------------------------------------------------------------- §9 ---

test('an unattended run never consents to removing a component, so it refuses', async () => {
  const e = fx({
    json: { [join(OURS, 'config.json')]: CFG, [TG_CFG]: { daemonStateDir: OURS } },
    env: { OURS_ASSUME_YES: '1' },
  });
  assert.equal(await runUninstall(['--state-dir', OURS], e), EXIT_REFUSED);
  assert.deepEqual(e.recorder.asked, [], 'no question is asked');
  assert.deepEqual(e.recorder.ran, [], 'and nothing is removed');
});

test('an unattended --purge never deletes state', async () => {
  const e = fx({ json: { [join(OURS, 'config.json')]: CFG }, env: { OURS_ASSUME_YES: '1' }, typed: OURS });
  assert.equal(await runUninstall(['--state-dir', OURS, '--purge'], e), EXIT_OK);
  assert.deepEqual(e.recorder.removed, []);
  assert.match(said(e), /never deleted non-interactively/);
});

// ------------------------------------------------------------- §8 step 6 -----

test('global packages are kept while another daemon still needs them', async () => {
  const e = fx({ json: { [join(OURS, 'config.json')]: CFG }, known: [OURS, join(HOME, '.ours-tg')] });
  await runUninstall(['--state-dir', OURS], e);
  assert.ok(!e.recorder.ran.some((c) => c.includes('rm')), 'nothing removed globally');
  assert.match(said(e), /kept — still used by the daemon at/);
});

test('global packages go only when this was the last daemon', async () => {
  const e = fx({ json: { [join(OURS, 'config.json')]: CFG }, known: [OURS] });
  await runUninstall(['--state-dir', OURS], e);
  const removals = e.recorder.ran.filter((c) => c.includes('rm')).map((c) => c[c.length - 1]);
  assert.deepEqual(removals, ['@ours.network/cli', '@ours.network/mcp']);
});

// ------------------------------------------------- the harness plugin phase --

const HERMES_CFG = join(HOME, '.hermes', 'config.yaml');
const BLOCK = ['# >>> ours.network plugin (managed block)', 'mcpServers:', '# <<< ours.network plugin'];

test('the plugin phase strips only our block, and keeps the file', async () => {
  const e = fx({
    json: { [join(OURS, 'config.json')]: CFG },
    text: { [HERMES_CFG]: `theirs\n${BLOCK.join('\n')}\nalso theirs\n` },
    present: (p) => String(p).includes('.hermes'),
  });
  assert.equal(await runUninstall(['--state-dir', OURS], e), EXIT_OK);
  const [path, body] = e.recorder.wroteText.find(([p]) => p === HERMES_CFG);
  assert.equal(path, HERMES_CFG);
  assert.equal(body, 'theirs\nalso theirs\n', 'the file is kept — only our span goes');
  assert.ok(e.recorder.ran.some((c) => c.join(' ') === 'npm rm -g @ours.network/hermes'));
});

test('an unterminated block is reported and the file is never written', async () => {
  const e = fx({
    json: { [join(OURS, 'config.json')]: CFG },
    text: { [HERMES_CFG]: '# >>> ours.network plugin (managed block)\nmcpServers:\ntheir own settings\n' },
    present: (p) => String(p).includes('.hermes'),
  });
  await runUninstall(['--state-dir', OURS], e);
  assert.deepEqual(e.recorder.wroteText, [], 'damage we cannot bound is damage we do not do');
  assert.match(said(e), /no closing marker/);
});

test('a second daemon leaves every plugin file alone', async () => {
  const e = fx({
    json: { [join(OURS, 'config.json')]: CFG },
    text: { [HERMES_CFG]: `theirs\n${BLOCK.join('\n')}\n` },
    present: () => true,
    known: [OURS, resolve(HOME, '.ours-tg')],
  });
  await runUninstall(['--state-dir', OURS], e);
  assert.deepEqual(e.recorder.wroteText, []);
  assert.deepEqual(e.recorder.removed, []);
  assert.match(said(e), /harness plugins kept/);
});

test("Claude Code's own removal is always printed, even when nothing else is", async () => {
  const e = fx({ json: { [join(OURS, 'config.json')]: CFG } });
  await runUninstall(['--state-dir', OURS], e);
  assert.match(said(e), /\/plugin uninstall ours/);
  assert.match(said(e), /nothing on disk is ours to remove/);
});

// ------------------------------------- the component config we cannot read ---

test('a corrupt connector config refuses the run and removes NOTHING', async () => {
  // The fail-open this closes: readJson turned the parse error into null, the
  // connector looked absent, and the daemon was removed out from under it.
  const e = fx({
    json: { [join(OURS, 'config.json')]: CFG },
    text: { [TG_CFG]: '{ "daemonStateDir": "/home/me/.ours"' },
  });
  assert.equal(await runUninstall(['--state-dir', OURS], e), EXIT_REFUSED);
  assert.deepEqual(e.recorder.ran, [], 'nothing stopped, uninstalled or npm-removed');
  assert.deepEqual(e.recorder.wrote, [], 'and no config rewritten');
  assert.deepEqual(e.recorder.wroteText, []);
  assert.deepEqual(e.recorder.removed, [], 'and nothing deleted');
  assert.match(said(e), /corrupt or unsafe to inspect/);
});

test('the corrupt-config refusal is not asked away, and beats even --purge', async () => {
  const e = fx({
    json: { [join(OURS, 'config.json')]: CFG },
    text: { [COWORK_CFG]: 'not json' },
    answers: [true, true, true],
    typed: OURS,
  });
  assert.equal(await runUninstall(['--state-dir', OURS, '--purge'], e), EXIT_REFUSED);
  assert.deepEqual(e.recorder.removed, [], 'the irreversible step is never reached');
  assert.deepEqual(e.recorder.asked, [], 'and the operator is not offered a way to consent past it');
});
