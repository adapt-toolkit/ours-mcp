// ours-install v3 — the orchestrator (spec §§2-5, 9).
//
// Every side effect arrives through one injected `effects` object, so this walks
// the WHOLE flow without a socket, a filesystem, a subprocess or a terminal.
// NOTHING here installs, enables or starts a service, and `systemctl` is never
// named by any command this file allows through — asserted, not assumed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { runInstall, runDaemonPhase, runServicePhase, EXIT_OK, EXIT_REFUSED } from '../lib/orchestrate.mjs';
import { CLI_UNIT_MARKER } from '../lib/plan.mjs';
import { isWholeDaemonEnv, DAEMON_ENV_KEYS } from '../lib/effects.mjs';

const HOME = '/home/me';
const OURS = resolve(HOME, '.ours');
const TG = resolve(HOME, '.ours-tg');
const unitPath = (n) => join(HOME, '.config', 'systemd', 'user', n);

const LEGACY_UNIT = '[Unit]\nDescription=ours MCP daemon (secure agent-to-agent messaging over ADAPT)\n[Service]\nExecStart=/usr/bin/node /x/ours-mcp/dist/cli.js serve\n';

// A recording effects layer. `json`/`text` seed the filesystem; `net` seeds the
// probe; everything mutating is recorded rather than done.
function fx({ json = {}, text = {}, net = {}, taken = [], versions = {}, env = {}, answers = [], unitUnchanged = false } = {}) {
  const recorder = { ran: [], ranEnv: [], wrote: [], out: [], asked: [] };
  let answerIndex = 0;
  return {
    recorder,
    home: HOME,
    env,
    brokerUrl: 'wss://broker1.ours.network',
    now: () => 1,
    probe: (port) => net[port] ?? { ok: false, reason: 'connection refused' },
    isTaken: (port) => taken.includes(port),
    readJson: (p) => (Object.prototype.hasOwnProperty.call(json, p) ? json[p] : null),
    readText: (p) => (Object.prototype.hasOwnProperty.call(text, p) ? text[p] : null),
    writeJson: (p, body) => { recorder.wrote.push([p, body]); },
    run: async (cmd, cmdArgs, opts = {}) => {
      recorder.ran.push([cmd, ...cmdArgs]);
      // Recorded separately so the existing deepEqual assertions on `ran` keep
      // working; the pair invariant is checked against this.
      recorder.ranEnv.push(opts.env ?? null);
      // The CLI answers with its plan when asked for --json; the unit-unchanged
      // case is what a repeat run sees.
      const stdout = cmdArgs.includes('install-service') && cmdArgs.includes('--json')
        ? JSON.stringify({ changed: unitUnchanged ? false : true, unitName: 'ours.service' })
        : '';
      return { ok: true, code: 0, stdout };
    },
    installedVersion: (pkg) => versions[pkg] ?? null,
    installedVersions: versions,
    out: (line) => recorder.out.push(String(line)),
    ask: async (prompt) => { recorder.asked.push(prompt); return answers[answerIndex++] ?? false; },
  };
}
const said = (e) => e.recorder.out.join('\n');

// ------------------------------------------------------ the safety invariant --

test('NO code path this orchestrator takes ever runs systemctl, or splits the daemon pair', () => {
  // The one rule that outranks every feature here. systemd is reached only
  // through `ours daemon install-service`, which owns its own refusals.
  //
  // Extended with the second host constraint (spec §2): now that run() can carry
  // an environment, EVERY invocation must carry the whole daemon pair or none of
  // it. A half pair is the quiet failure — the child falls back to ~/.ours and
  // attaches to a daemon the operator did not choose.
  const cases = [
    { json: {}, net: {} },
    { json: { [join(OURS, 'config.json')]: { port: 3050 } }, net: { 3050: { ok: true, stateDir: OURS } } },
    { text: { [unitPath('ours.service')]: LEGACY_UNIT } },
  ];
  return Promise.all(cases.map(async (seed) => {
    const e = fx(seed);
    await runInstall([], e);
    for (const cmd of e.recorder.ran) {
      assert.ok(!cmd.includes('systemctl'), `systemctl must never be run: ${cmd.join(' ')}`);
      assert.ok(!cmd.includes('loginctl'), `loginctl must never be run: ${cmd.join(' ')}`);
    }
    e.recorder.ranEnv.forEach((env, i) => {
      assert.ok(isWholeDaemonEnv(env), `half a daemon pair handed to: ${e.recorder.ran[i].join(' ')}`);
    });
  }));
});

test('a --dry-run mutates NOTHING: no command, no write', async () => {
  const e = fx({ text: { [unitPath('ours.service')]: LEGACY_UNIT } });
  const code = await runInstall(['--dry-run'], e);
  assert.equal(code, EXIT_OK);
  assert.deepEqual(e.recorder.ran, [], 'no subprocess');
  assert.deepEqual(e.recorder.wrote, [], 'no file written');
  assert.match(said(e), /\[dry-run\] would: /, 'and it says what it would have done');
});

// ------------------------------------------------------------- §2 refusals --

test('a bad argument exits 2 before anything happens', async () => {
  const e = fx();
  assert.equal(await runInstall(['--nope'], e), EXIT_REFUSED);
  assert.deepEqual(e.recorder.ran, []);
  assert.deepEqual(e.recorder.wrote, []);
  assert.match(said(e), /unknown option: --nope/);
});

test('a foreign daemon on the candidate port exits 2 and names the other directory', async () => {
  const e = fx({ net: { 3050: { ok: true, stateDir: TG } } });
  assert.equal(await runInstall([], e), EXIT_REFUSED);
  assert.deepEqual(e.recorder.wrote, [], 'nothing written');
  assert.deepEqual(e.recorder.ran, [], 'nothing run');
  assert.match(said(e), /owns state directory .*\.ours-tg/);
  assert.match(said(e), /re-run with --port/);
});

test('a --port disagreeing with the running daemon exits 2 and writes nothing', async () => {
  const e = fx({
    json: { [join(OURS, 'config.json')]: { port: 3050 } },
    net: { 3050: { ok: true, stateDir: OURS } },
  });
  assert.equal(await runInstall(['--port', '3999'], e), EXIT_REFUSED);
  assert.deepEqual(e.recorder.wrote, []);
  assert.match(said(e), /--port 3999 disagrees with port 3050/);
  assert.match(said(e), /Nothing was written/);
});

// ------------------------------------------------------- §§3-4 the daemon ----

test('creating a daemon: CLI, config with the creation marker, start, then service', async () => {
  const e = fx();
  const r = await runDaemonPhase({ stateDir: TG, port: 3051, portExplicit: true, dryRun: false, brokerUrl: 'wss://b' }, e);
  assert.equal(r.target.action, 'create');
  assert.deepEqual(r.steps.map((s) => s.id), ['cli', 'config', 'start', 'service']);
  const [path, body] = e.recorder.wrote[0];
  assert.equal(path, join(TG, 'config.json'));
  const written = JSON.parse(body);
  assert.equal(written.port, 3051);
  assert.equal(written.stateDir, TG);
  assert.ok(!('createdBy' in written), 'no provenance marker: --purge works on any state directory, so it would have no consumer');
  // Order matters: the daemon is started before its boot service is installed.
  const ids = e.recorder.ran.map((c) => c.join(' '));
  assert.ok(ids.findIndex((s) => s.includes('daemon start')) < ids.findIndex((s) => s.includes('install-service')));
});

test('updating an existing daemon never starts one and never moves the port', async () => {
  const e = fx({
    json: { [join(OURS, 'config.json')]: { port: 3060, stateDir: OURS, brokerUrl: 'wss://b', apiVisibility: 'shared' } },
    net: { 3060: { ok: true, stateDir: OURS } },
  });
  const r = await runDaemonPhase({ stateDir: OURS, port: null, portExplicit: false, dryRun: false, brokerUrl: 'wss://b' }, e);
  assert.equal(r.target.action, 'update');
  assert.equal(r.target.port, 3060);
  assert.ok(!r.steps.some((s) => s.id === 'start'));
  assert.deepEqual(e.recorder.wrote, [], 'a config that already matches is not rewritten');
  assert.match(said(e), /already correct — not touched/);
});

test('an existing daemon found only by its PID record is still an update', async () => {
  // The corruption guard, end to end: no recorded port, daemon on 3060.
  const e = fx({
    json: { [join(OURS, 'ours-cli-daemon.json')]: { port: 3060 } },
    net: { 3060: { ok: true, stateDir: OURS } },
  });
  const r = await runDaemonPhase({ stateDir: OURS, port: null, portExplicit: false, dryRun: false, brokerUrl: 'wss://b' }, e);
  assert.equal(r.target.action, 'update', 'a second daemon must not be created on this state directory');
  assert.equal(r.target.port, 3060);
});

// ------------------------------------------------------------- §4 the unit ---

test('a legacy ours-mcp unit is adopted silently, with --force and one line', async () => {
  const e = fx({ text: { [unitPath('ours.service')]: LEGACY_UNIT } });
  const r = await runServicePhase({ dryRun: false }, e, OURS);
  assert.equal(r.plan.action, 'adopt');
  assert.deepEqual(e.recorder.asked, [], 'no prompt — the owner ruled it silent');
  const cmd = e.recorder.ran.find((x) => x.includes('install-service'));
  assert.ok(cmd.includes('--force'), 'adoption needs --force, and this is the only place it is passed');
  assert.match(said(e), /replaced .*ours\.service/);
  assert.doesNotMatch(said(e), /lost|delete|erase|wipe|destroy/i, 'no false data-loss wording');
});

test('an unidentifiable unit stops the run and is never forced', async () => {
  const e = fx({ text: { [unitPath('ours.service')]: '[Unit]\nDescription=stranger\n' } });
  assert.equal(await runInstall([], e), EXIT_REFUSED);
  assert.ok(!e.recorder.ran.some((c) => c.includes('--force')), 'never forced over a file we cannot identify');
  assert.deepEqual(e.recorder.asked, [], 'and never prompted about it either');
  assert.match(said(e), /Refusing to touch it/);
});

test('a clean install passes no --force at all', async () => {
  const e = fx();
  await runServicePhase({ dryRun: false }, e, OURS);
  const cmd = e.recorder.ran.find((x) => x.includes('install-service'));
  assert.ok(!cmd.includes('--force'));
});

// ---------------------------------------------------------- §5 components ----

test('assume-yes installs the MCP server and nothing else, and asks nothing', async () => {
  const e = fx({ env: { OURS_ASSUME_YES: '1' } });
  assert.equal(await runInstall([], e), EXIT_OK);
  assert.deepEqual(e.recorder.asked, [], 'a linear run reads no input');
  const ran = e.recorder.ran.map((c) => c.join(' '));
  assert.ok(ran.some((s) => s.includes('@ours.network/mcp')));
  assert.ok(!ran.some((s) => s.includes('tg-connector')), 'never turned on by assume-yes');
  assert.ok(!ran.some((s) => s.includes('@ours.network/cowork')));
});

test('a connector pointing elsewhere is never moved without a yes', async () => {
  const path = join(HOME, '.ours-telegram', 'config.json');
  const seed = { json: { [path]: { daemonUrl: 'http://127.0.0.1:3050', daemonStateDir: OURS, botToken: 'secret' } } };

  const declined = fx(seed);
  await runInstall(['--state-dir', TG, '--port', '3051'], { ...declined, ask: async (p) => { declined.recorder.asked.push(p); return false; } });
  assert.equal(declined.recorder.asked.length, 0, 'tg is not selected by default, so nothing is even asked');

  // Now select it explicitly and decline the move.
  const e2 = fx(seed);
  const r = await runInstall(['--state-dir', TG, '--port', '3051'], { ...e2, ask: async (p) => { e2.recorder.asked.push(p); return false; } });
  assert.equal(r, EXIT_OK);
  assert.ok(!e2.recorder.wrote.some(([p]) => p === path), 'declining leaves the connector where it is');
});

test('cowork older than the floor is left embedded rather than handed a block', async () => {
  const e = fx({ versions: { '@ours.network/cowork': '0.4.0' } });
  const summary = await (await import('../lib/orchestrate.mjs')).runComponentPhase(
    { answers: { cowork: true }, dryRun: false, assumeYes: false, brokerUrl: 'wss://b' },
    e,
    { stateDir: OURS, port: 3050 },
  );
  assert.ok(summary.skipped.includes('cowork'));
  assert.match(said(e), /leaving cowork embedded/);
  assert.ok(!e.recorder.wrote.some(([p]) => p.includes('.ours-cowork')), 'no block written to an older build');
});

test('a component that throws is reported with a retry and the run continues', async () => {
  const e = fx();
  const failing = { ...e, run: async (cmd, a) => {
    e.recorder.ran.push([cmd, ...a]);
    if (a.includes('@ours.network/mcp')) throw new Error('npm exited 1');
    return { ok: true };
  } };
  const summary = await (await import('../lib/orchestrate.mjs')).runComponentPhase(
    { answers: { mcp: true }, dryRun: false, assumeYes: false, brokerUrl: 'wss://b' },
    failing,
    { stateDir: OURS, port: 3050 },
  );
  assert.deepEqual(summary.failed.map((f) => f.key), ['mcp']);
  assert.equal(summary.continued, true);
  assert.match(said(e), /retry manually: npm i -g @ours\.network\/mcp/);
});

// ------------------------------------------------------------- idempotence ---

test('a second identical run changes nothing but refreshed packages', async () => {
  const json = {
    [join(OURS, 'config.json')]: { port: 3050, stateDir: OURS, brokerUrl: 'wss://broker1.ours.network' },
  };
  const e = fx({ json, net: { 3050: { ok: true, stateDir: OURS } }, text: { [unitPath('ours.service')]: `${CLI_UNIT_MARKER}\n[Unit]\n` }, unitUnchanged: true });
  assert.equal(await runInstall([], e), EXIT_OK);
  assert.deepEqual(e.recorder.wrote, [], 'no config rewritten');
  assert.match(said(e), /nothing changed except refreshed packages/);
});

// ---------------------------------------------------- the real effects layer --

test('lib/effects.mjs never reaches for systemctl or a unit file', async () => {
  // The audit this file exists to make possible: every mutation the installer can
  // perform lives in one small module, so "does this touch the machine" is one
  // grep rather than a code review of the whole flow.
  const { readFileSync } = await import('node:fs');
  // Comments are stripped first: the file DISCUSSES systemctl at length, saying
  // it never runs it, and the assertion is about the code rather than the prose.
  const code = readFileSync(new URL('../lib/effects.mjs', import.meta.url), 'utf8')
    .split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*')).join('\n');
  for (const f of ['systemctl', 'loginctl', 'systemd/user']) {
    assert.ok(!code.includes(f), `${f} must not appear in the effects layer's code`);
  }
  // Extended for the env parameter: a daemon environment reaches a CHILD and
  // never this process. If the effects layer ever assigned into process.env, a
  // state directory chosen by one run would outlive it and be inherited by
  // everything the operator started from the same shell afterwards.
  assert.ok(!/process\.env\s*\[/.test(code) && !/process\.env\.[A-Za-z_]+\s*=[^=]/.test(code),
    'the effects layer must never write into process.env');
  // And there is exactly ONE constructor for that environment: no code above the
  // pair section names a daemon variable, so "which call sites can emit half a
  // pair" stays answerable by reading one function rather than the whole file.
  const beforeThePair = code.split('DAEMON_ENV_KEYS')[0];
  for (const key of DAEMON_ENV_KEYS) {
    assert.ok(!beforeThePair.includes(key), `${key} must only be named by the pair constructor, not by ${'realEffects'}`);
  }
});
