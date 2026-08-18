// ours-install v3 — the orchestrator (spec §§2-5, 9).
//
// Every side effect arrives through one injected `effects` object, so this walks
// the WHOLE flow without a socket, a filesystem, a subprocess or a terminal.
// NOTHING here installs, enables or starts a service, and `systemctl` is never
// named by any command this file allows through — asserted, not assumed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { runInstall, runDaemonPhase, runServicePhase, EXIT_OK, EXIT_REFUSED } from '../lib/orchestrate.mjs';
import { CLI_UNIT_MARKER } from '../lib/plan.mjs';
import { isWholeDaemonEnv, DAEMON_ENV_KEYS } from '../lib/effects.mjs';

import { fx, said, HOME, OURS, TG } from './fake-effects.mjs';

const unitPath = (n) => join(HOME, '.config', 'systemd', 'user', n);

const LEGACY_UNIT = '[Unit]\nDescription=ours MCP daemon (secure agent-to-agent messaging over ADAPT)\n[Service]\nExecStart=/usr/bin/node /x/ours-mcp/dist/cli.js serve\n';

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

test('a foreign daemon on the RECORDED port exits 2 and names the other directory', async () => {
  // On the port this directory's own config named — which is what makes it an
  // incoherent selection rather than just a busy machine.
  const e = fx({ json: { [join(OURS, 'config.json')]: { port: 3050 } }, net: { 3050: { ok: true, stateDir: TG } } });
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

test('creating a daemon: the daemon package, config, start, then service', async () => {
  const e = fx();
  const r = await runDaemonPhase({ stateDir: TG, port: 3051, portExplicit: true, dryRun: false, brokerUrl: 'wss://b' }, e);
  assert.equal(r.target.action, 'create');
  assert.deepEqual(r.steps.map((s) => s.id), ['daemon-package', 'config', 'start', 'service']);
  const [path, body] = e.recorder.wrote[0];
  assert.equal(path, join(TG, 'config.json'));
  const written = JSON.parse(body);
  assert.equal(written.port, 3051);
  assert.equal(written.stateDir, TG);
  assert.ok(!('createdBy' in written), 'no provenance marker: --purge works on any state directory, so it would have no consumer');
  // Order matters: the daemon is started before its boot service is installed.
  const ids = e.recorder.ran.map((c) => c.join(' '));
  assert.ok(ids.findIndex((s) => s === 'ours-mcp start') < ids.findIndex((s) => s.includes('install-service')));
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

test('a legacy ours-mcp unit is adopted silently, and the DECISION is now the whole guard', async () => {
  // --force is gone: ours-mcp's install-service takes no flags and writes the unit
  // unconditionally, so there is no marker check behind classifyUnit any more.
  // What used to be belt (the decision) and braces (the CLI's refusal) is now the
  // decision alone — which makes planServiceInstall's `foreign` refusal
  // load-bearing rather than a second opinion.
  const e = fx({ text: { [unitPath('ours.service')]: LEGACY_UNIT } });
  const r = await runServicePhase({ dryRun: false }, e, OURS, 3050);
  assert.equal(r.plan.action, 'adopt');
  assert.deepEqual(e.recorder.asked, [], 'no prompt — the owner ruled it silent');
  assert.ok(e.recorder.ran.some((x) => x.join(' ') === 'ours-mcp install-service'));
  assert.match(said(e), /replaced .*ours\.service/);
  assert.doesNotMatch(said(e), /lost|delete|erase|wipe|destroy/i, 'no false data-loss wording');
});

test('an unidentifiable unit stops the run and is never forced', async () => {
  const e = fx({ text: { [unitPath('ours.service')]: '[Unit]\nDescription=stranger\n' } });
  assert.equal(await runInstall([], e), EXIT_REFUSED);
  assert.ok(!e.recorder.ran.some((c) => c.includes('--force')), 'never forced over a file we cannot identify');
  // Never prompted about it EITHER: an unidentified unit is a refusal, not a
  // question. (The broker question belongs to the create path and is asked
  // before this; what must not exist is a prompt offering to overwrite.)
  assert.ok(!e.recorder.asked.some((p) => /unit|overwrite|force|service/i.test(p)),
    'and never prompted about it either');
  assert.match(said(e), /Refusing to touch it/);
});

test('a clean install passes no --force at all', async () => {
  const e = fx();
  await runServicePhase({ dryRun: false }, e, OURS, 3050);
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
  // The run asks its own questions (broker, fleet, voice); what it must never
  // ask unprompted is the one about MOVING the connector, because tg is not
  // selected by default and an unselected component is not negotiated over.
  assert.ok(!declined.recorder.asked.some((p) => /Point it at/.test(p)),
    'tg is not selected by default, so the move is never even raised');

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

// ----------------------------------------------------------------- §5 channel --

test('CHANNEL=nightly installs the NIGHTLY component packages, not stable ones beside nightly plugins', async () => {
  // The whole point, asserted on the recorded invocation rather than on a screen
  // line: a nightly run that installs a stable MCP server produces exactly the
  // split-brain deployment the channel exists to prevent, and it looked like
  // success because the plugins and ours-fleet WERE nightly.
  const e = fx({ env: { OURS_CHANNEL: 'nightly', OURS_ASSUME_YES: '1' } });
  await runInstall([], e);
  const installs = e.recorder.ran.filter((c) => c.join(' ').startsWith('npm i -g')).map((c) => c[c.length - 1]);
  assert.ok(installs.includes('@ours.network/mcp@nightly'), `mcp must be nightly, got: ${installs.join(', ')}`);
  assert.ok(
    !installs.includes('@ours.network/mcp'),
    'and never the untagged name on a nightly run — that installs @latest',
  );
});

test('a nightly run selecting the connector and cowork tags BOTH of them too', async () => {
  const e = fx({
    env: { OURS_CHANNEL: 'nightly' },
    versions: { '@ours.network/cowork': '0.5.0' },
  });
  await (await import('../lib/orchestrate.mjs')).runComponentPhase(
    { answers: { mcp: true, tg: true, cowork: true }, dryRun: false, assumeYes: false, brokerUrl: 'wss://b', channel: 'nightly' },
    e,
    { stateDir: OURS, port: 3050 },
  );
  const installs = e.recorder.ran.filter((c) => c.join(' ').startsWith('npm i -g')).map((c) => c[c.length - 1]);
  assert.deepEqual(installs, [
    '@ours.network/mcp@nightly',
    '@ours.network/tg-connector@nightly',
    '@ours.network/cowork@nightly',
  ]);
});

test('the version column and the cowork floor still read the BARE package name', async () => {
  // The trap in the fix rather than in the bug: keying the version lookup by the
  // tagged spec returns null forever, which fails the cowork floor closed and
  // reports "too old" for a build that is new enough.
  const asked = [];
  const base = fx({ env: { OURS_CHANNEL: 'nightly' }, versions: { '@ours.network/cowork': '0.5.0' } });
  const e = { ...base, installedVersion: (pkg) => { asked.push(pkg); return base.installedVersion(pkg); } };
  const summary = await (await import('../lib/orchestrate.mjs')).runComponentPhase(
    { answers: { cowork: true }, dryRun: false, assumeYes: false, brokerUrl: 'wss://b', channel: 'nightly' },
    e,
    { stateDir: OURS, port: 3050 },
  );
  assert.deepEqual(asked, ['@ours.network/cowork'], 'no dist-tag in a version lookup');
  assert.ok(summary.installed.includes('cowork'), 'so the floor passes and the block is written');
});

test('a failed component on nightly hands back a NIGHTLY retry command', async () => {
  const e = fx({ env: { OURS_CHANNEL: 'nightly' } });
  const failing = { ...e, run: async (cmd, a) => {
    e.recorder.ran.push([cmd, ...a]);
    if (a.some((x) => String(x).startsWith('@ours.network/mcp'))) throw new Error('npm exited 1');
    return { ok: true };
  } };
  const summary = await (await import('../lib/orchestrate.mjs')).runComponentPhase(
    { answers: { mcp: true }, dryRun: false, assumeYes: false, brokerUrl: 'wss://b', channel: 'nightly' },
    failing,
    { stateDir: OURS, port: 3050 },
  );
  assert.deepEqual(summary.failed.map((f) => f.retry), ['npm i -g @ours.network/mcp@nightly'],
    'a stable retry command would walk the operator into the split-brain by hand');
});

// ------------------------------------------------- the config journal (L2) ---
//
// v3 could write a config file describing a daemon it then failed to bring up,
// print one warning, and go on to say "install complete". The bytes and the daemon
// they describe are ONE unit of work; these pin that they are treated as one.

test('a daemon that fails to start does not leave a config naming its port', async () => {
  // The failure state that decides this: the next run reads config.json FIRST
  // (target.mjs findDaemon), probes the port nothing listens on, and has only the
  // ours-cli-daemon.json lookup between it and creating a SECOND daemon on this
  // state directory — two writers on one state_data.bin.
  const e = fx({ runFails: ['ours-mcp start'] });
  await assert.rejects(() => runInstall([], e));
  assert.deepEqual(e.recorder.restored.map(([p]) => p), [join(OURS, 'config.json')]);
  assert.match(said(e), /did not reach the state its config describes/);
  assert.match(said(e), /removed .*config\.json — this run created it and did not finish/);
});

test('an existing config is rolled back to its PREVIOUS bytes, not deleted', async () => {
  const before = { port: 3050, stateDir: OURS, brokerUrl: 'wss://old.example', keepThis: true };
  const e = fx({
    json: { [join(OURS, 'config.json')]: before },
    net: { 3050: { ok: true, stateDir: OURS } },
    runFails: ['install-service'],
    env: { OURS_ASSUME_YES: '1' },
  });
  await assert.rejects(() => runInstall([], e));
  const [path, snapshot] = e.recorder.restored[0];
  assert.equal(path, join(OURS, 'config.json'));
  assert.equal(snapshot.exists, true);
  assert.equal(JSON.parse(snapshot.text).keepThis, true, 'the operator keys come back too');
  assert.match(said(e), /rolled back .*config\.json to its previous contents/);
});

test('the rollback states what it could NOT undo', async () => {
  const e = fx({ runFails: ['ours-mcp start'] });
  await assert.rejects(() => runInstall([], e));
  assert.match(said(e), /completed package installs were not rolled back/,
    'the CLI package install always ran by this point; saying so is the honest boundary');
});

test('a REFUSAL after the config write rolls it back too', async () => {
  // An unknown unit file stops the run exactly as a failed start does, and it
  // stops it with config.json already rewritten. Same rollback, same report.
  const e = fx({ text: { [unitPath('ours.service')]: '[Unit]\nDescription=somebody elses thing\n' } });
  const code = await runInstall([], e);
  assert.equal(code, EXIT_REFUSED);
  assert.deepEqual(e.recorder.restored.map(([p]) => p), [join(OURS, 'config.json')]);
});

test('a failed rollback is REPORTED, never swallowed and never thrown over the real error', async () => {
  const e = fx({ runFails: ['ours-mcp start'], restoreFails: [join(OURS, 'config.json')] });
  // The original failure must be what propagates: losing it to a second error
  // raised by the recovery would hide the thing that actually went wrong.
  await assert.rejects(() => runInstall([], e), /ours-mcp exited 1/, 'the original failure survives');
  assert.match(said(e), /could NOT roll back .*config\.json: permission denied/);
});

test('a --dry-run snapshots nothing, because it wrote nothing', async () => {
  const e = fx({ runFails: ['ours-mcp start'] });
  const code = await runInstall(['--dry-run'], e);
  assert.equal(code, EXIT_OK, 'a dry run never reaches a real failure');
  assert.deepEqual(e.recorder.restored, []);
  assert.ok(!said(e).includes('rolled back'), 'and says nothing about rolling back');
});

test('a connector whose service fails does not keep a config pointing at this daemon', async () => {
  // The config names this daemon while the unit still carries the OLD environment,
  // and the component phase would report one failed line and let the run finish.
  const e = fx({
    json: { [join(HOME, '.ours-telegram', 'config.json')]: { botToken: 'secret', daemonUrl: 'http://127.0.0.1:9999', daemonStateDir: '/elsewhere' } },
    runFails: ['ours-tg-connector install-service'],
    answers: [true],   // yes, repoint it — the case that writes the most dangerous bytes
  });
  const summary = await (await import('../lib/orchestrate.mjs')).runComponentPhase(
    { answers: { tg: true }, dryRun: false, assumeYes: false, brokerUrl: 'wss://b', channel: 'latest' },
    e,
    { stateDir: OURS, port: 3050 },
  );
  assert.deepEqual(summary.failed.map((f) => f.key), ['tg']);
  const [path, snapshot] = e.recorder.restored[0];
  assert.equal(path, join(HOME, '.ours-telegram', 'config.json'));
  assert.equal(JSON.parse(snapshot.text).daemonUrl, 'http://127.0.0.1:9999', 'back to the daemon it was on');
  assert.equal(JSON.parse(snapshot.text).botToken, 'secret');
});

test('a component rollback NEVER touches the daemon that came up correctly', async () => {
  // The whole reason the journal is scoped per unit of work rather than per run:
  // nightly's run-wide journal, copied here, would undo the daemon's own config
  // because a connector failed.
  const e = fx({ runFails: ['ours-cowork install-service'], versions: { '@ours.network/cowork': '0.5.0' } });
  await (await import('../lib/orchestrate.mjs')).runComponentPhase(
    { answers: { cowork: true }, dryRun: false, assumeYes: false, brokerUrl: 'wss://b', channel: 'latest' },
    e,
    { stateDir: OURS, port: 3050 },
  );
  assert.deepEqual(
    e.recorder.restored.map(([p]) => p),
    [join(HOME, '.ours-cowork', 'config.json')],
    'only cowork\'s own config — never the daemon config.json',
  );
  assert.match(said(e), /leaves cowork embedded as it was/);
});

test('a config that did not change is not snapshotted, so nothing is "rolled back"', async () => {
  // Restoring a file this run never wrote would be a change dressed as a recovery.
  const already = { daemon: { mode: 'external', endpoint: 'http://127.0.0.1:3050', stateDir: OURS } };
  const e = fx({
    json: { [join(HOME, '.ours-cowork', 'config.json')]: already },
    runFails: ['ours-cowork install-service'],
    versions: { '@ours.network/cowork': '0.5.0' },
  });
  await (await import('../lib/orchestrate.mjs')).runComponentPhase(
    { answers: { cowork: true }, dryRun: false, assumeYes: false, brokerUrl: 'wss://b', channel: 'latest' },
    e,
    { stateDir: OURS, port: 3050 },
  );
  assert.deepEqual(e.recorder.restored, [], 'the file was already correct and was never touched');
});

test('the replaced legacy unit is NAMED in the rollback, because it cannot be restored', async () => {
  // Writing unit bytes back into ~/.config/systemd/user would break the invariant
  // that systemd is reached only through `ours daemon install-service`, and without
  // a daemon-reload it would not even mean anything. So it is reported, not fixed.
  const e = fx({
    text: { [unitPath('ours.service')]: LEGACY_UNIT },
    runFails: ['install-service'],
  });
  await assert.rejects(() => runInstall([], e));
  assert.match(said(e), /is NOT restored — the older ours-mcp unit is gone/);
  assert.match(said(e), /state directory .* is untouched|state directory is untouched/);
  assert.deepEqual(e.recorder.restored.map(([p]) => p), [join(OURS, 'config.json')],
    'the config still goes back; only the unit does not');
});

test('the end screen tells a running harness it must restart before any of this works', async () => {
  // THE REPRODUCTION for the restart hints: v3 printed "Everything installed
  // cleanly" and nothing else, so a user went back to an already-open Claude Code,
  // found no ours tools, and read a successful install as a failed one.
  const e = fx({
    env: { OURS_ASSUME_YES: '1' },
    harnesses: [{ name: 'claude-code', status: 'ok', label: 'Claude Code' }],
  });
  await runInstall([], e);
  const screen = said(e);
  assert.match(screen, /restart Claude Code/);
  assert.match(screen, /already open has not picked it up yet/);
  assert.ok(
    screen.indexOf('restart Claude Code') < screen.indexOf('ONE LAST STEP')
      || !screen.includes('ONE LAST STEP'),
    'said before the hand-off prompt: it is the only thing here the operator must do himself',
  );
});

// ------------------------------------------------- the selection screen (C1) --

const SECOND_DIR = join(HOME, '.ours-work');

test('several daemons are SHOWN and the operator picks — never asked to type a path', async () => {
  const e = fx({
    known: [OURS, SECOND_DIR],
    json: {
      [join(OURS, 'config.json')]: { port: 3050, stateDir: OURS },
      [join(SECOND_DIR, 'config.json')]: { port: 3060, stateDir: SECOND_DIR },
    },
    net: { 3060: { ok: true, stateDir: SECOND_DIR } },
    lines: ['2'],
  });
  await runInstall([], e);
  const screen = said(e);
  assert.match(screen, /Which ours daemon is this for\?/);
  assert.match(screen, /1\) .*\.ours\b/);
  assert.match(screen, /2\) .*\.ours-work/);
  assert.match(screen, /3\) create a new one at .*\.ours-2/);
  assert.match(screen, /using the ours daemon at .*\.ours-work/);
  assert.ok(
    e.recorder.askedLines.every((p) => !/state directory|path/i.test(p)),
    'the prompt asks for a NUMBER; spec §2 forbids asking for a path',
  );
});

test('the Telegram connector is never offered as a daemon to install into', async () => {
  // ~/.ours-telegram matches a ~/.ours* scan and has a config.json. Offering it
  // would let the operator pick it and have a daemon created inside the
  // connector's own directory.
  const TG_DIR = join(HOME, '.ours-telegram');
  const e = fx({
    known: [OURS, TG_DIR],
    json: {
      [join(OURS, 'config.json')]: { port: 3050, stateDir: OURS },
      [join(TG_DIR, 'config.json')]: { botToken: 's', daemonUrl: 'http://127.0.0.1:3050', daemonStateDir: OURS },
    },
    net: { 3050: { ok: true, stateDir: OURS } },
  });
  await runInstall([], e);
  assert.doesNotMatch(said(e), /Which ours daemon is this for\?/, 'one daemon, so no screen');
  assert.doesNotMatch(said(e), /\.ours-telegram/);
  assert.match(said(e), /the only one found/);
});

test('exactly one daemon: no question, but the run SAYS which one', async () => {
  const e = fx({
    known: [OURS],
    json: { [join(OURS, 'config.json')]: { port: 3050, stateDir: OURS } },
    net: { 3050: { ok: true, stateDir: OURS } },
  });
  await runInstall([], e);
  assert.deepEqual(e.recorder.askedLines.filter((p) => /Choose/.test(p)), [], 'no choice offered');
  assert.match(said(e), /using the ours daemon at .*\.ours \(port 3050\) — the only one found/);
});

test('--state-dir outranks everything detected: no screen at all', async () => {
  const e = fx({
    known: [OURS, SECOND_DIR],
    json: {
      [join(OURS, 'config.json')]: { port: 3050 },
      [join(SECOND_DIR, 'config.json')]: { port: 3060 },
    },
  });
  await runInstall(['--state-dir', TG], e);
  assert.doesNotMatch(said(e), /Which ours daemon is this for\?/);
  assert.match(said(e), new RegExp(`target ${TG}`));
});

test('a non-interactive run never sees the screen, whatever is on the machine', async () => {
  const e = fx({
    env: { OURS_ASSUME_YES: '1' },
    known: [OURS, SECOND_DIR],
    json: { [join(OURS, 'config.json')]: { port: 3050 }, [join(SECOND_DIR, 'config.json')]: { port: 3060 } },
  });
  await runInstall([], e);
  assert.doesNotMatch(said(e), /Which ours daemon is this for\?/);
  assert.deepEqual(e.recorder.askedLines, [], 'nothing asked at all');
});

test('an answer that is not on the list REFUSES and changes nothing', async () => {
  const e = fx({
    known: [OURS, SECOND_DIR],
    json: { [join(OURS, 'config.json')]: { port: 3050 }, [join(SECOND_DIR, 'config.json')]: { port: 3060 } },
    lines: ['/etc/passwd'],
  });
  assert.equal(await runInstall([], e), EXIT_REFUSED);
  assert.deepEqual(e.recorder.ran, [], 'nothing installed');
  assert.deepEqual(e.recorder.wrote, [], 'nothing written');
  assert.match(said(e), /not one of the numbers offered/);
});

test('picking "create a new one" targets the DERIVED directory, not the default', async () => {
  const e = fx({
    known: [OURS, SECOND_DIR],
    json: { [join(OURS, 'config.json')]: { port: 3050 }, [join(SECOND_DIR, 'config.json')]: { port: 3060 } },
    lines: ['3'],
  });
  await runInstall([], e);
  assert.match(said(e), /creating a new daemon at .*\.ours-2/);
  assert.ok(e.recorder.wrote.some(([p]) => p === join(HOME, '.ours-2', 'config.json')));
});

test('a left-over profile registry is NAMED as dead, and never deleted', async () => {
  // Anyone who used the nightly installer has one, and after the switch nothing
  // reads it. Deleting a file that describes someone's daemons is not an
  // installer's business — but leaving it looking live is worse than saying it is
  // not.
  const registry = join(OURS, 'installer-profiles.json');
  const e = fx({ json: { [join(OURS, 'config.json')]: { port: 3050 } } });
  const withRegistry = { ...e, exists: (p) => p === registry };
  await runInstall([], withRegistry);
  assert.match(said(e), /installer-profiles\.json is left over .* no longer read/);
  assert.match(said(e), /It is left alone/);
  assert.deepEqual(e.recorder.removed ?? [], [], 'nothing deleted');
});

// ------------------------------------------ daemon recovery after a failed unit --

test('a failed install-service does not leave the daemon down without trying to bring it back', async () => {
  // install-service can STOP a running daemon before it fails: it installs a unit
  // that will own the process. v3 just ended the run there, so a person who typed
  // ours-install and got an error was also, silently, left without the daemon they
  // had before.
  const e = fx({
    json: { [join(OURS, 'config.json')]: { port: 3050, stateDir: OURS, brokerUrl: 'wss://b' } },
    net: { 3050: { ok: true, stateDir: OURS } },
    runFails: ['install-service'],
    env: { OURS_ASSUME_YES: '1' },
  });
  await assert.rejects(() => runInstall([], e));
  const started = e.recorder.ran.filter((c) => c.join(' ') === 'ours-mcp start');
  assert.equal(started.length, 1, 'exactly one recovery attempt');
  assert.deepEqual(started[0], ['ours-mcp', 'start']);
  const startEnv = e.recorder.ranEnv[e.recorder.ran.findIndex((c) => c.join(' ') === 'ours-mcp start')];
  assert.equal(startEnv.OURS_CONFIG, join(OURS, 'config.json'), 'selected by environment, not by a flag');
  assert.match(said(e), /your daemon is running again/);
});

test('the two outcomes are told apart, because only one of them needs a human now', async () => {
  // "The service failed but the daemon is back" is a bad evening. "The service
  // failed AND it will not come back" is the one that needs someone tonight.
  const e = fx({
    json: { [join(OURS, 'config.json')]: { port: 3050, stateDir: OURS, brokerUrl: 'wss://b' } },
    net: { 3050: { ok: true, stateDir: OURS } },
    runFails: ['install-service', 'ours-mcp start'],
    env: { OURS_ASSUME_YES: '1' },
  });
  await assert.rejects(() => runInstall([], e));
  assert.match(said(e), /the daemon did NOT come back up/);
  assert.match(said(e), /OURS_CONFIG=.*config\.json ours-mcp start/, 'and the exact command to fix it');
});

test('a daemon that never started is not "recovered" — there is nothing to recover', async () => {
  // Running start after a failed start would fail again and stack a second, less
  // useful error on top of the first.
  const e = fx({ runFails: ['ours-mcp start'], env: { OURS_ASSUME_YES: '1' } });
  await assert.rejects(() => runInstall([], e));
  const starts = e.recorder.ran.filter((c) => c.join(' ') === 'ours-mcp start');
  assert.equal(starts.length, 1, 'the original attempt only — no retry');
  assert.doesNotMatch(said(e), /running again|did NOT come back up/);
});

test('a dry run recovers nothing, because it stopped nothing', async () => {
  const e = fx({ runFails: ['install-service'], env: { OURS_ASSUME_YES: '1' } });
  await runInstall(['--dry-run'], e);
  assert.deepEqual(e.recorder.ran, [], 'a dry run performs nothing at all');
});

// ------------------------------ macOS now gets a REAL boot service ----------
//
// The skip that used to live here is gone with the daemon change: the unit is
// installed by ours-mcp's own install-service, which handles systemd AND launchd,
// so there is no longer a platform on which the installer declines to try.
// Whether launchctl accepts the agent is still unproven — nothing here is macOS —
// but it is now real code rather than a documented refusal.

test('macOS attempts the boot service like any other platform', async () => {
  const e = fx({ platform: 'darwin', env: { OURS_ASSUME_YES: '1' } });
  const code = await runInstall([], e);
  assert.equal(code, EXIT_OK);
  assert.ok(e.recorder.ran.some((c) => c.join(' ').includes('install-service')), 'attempted, not skipped');
  assert.doesNotMatch(said(e), /not available on macOS/, 'and nothing claims a gap that no longer exists');
});

test('Linux is completely unaffected — same walk, same service install', async () => {
  const e = fx({ env: { OURS_ASSUME_YES: '1' } });
  await runInstall([], e);
  assert.ok(e.recorder.ran.some((c) => c.join(' ') === 'ours-mcp install-service'));
  assert.doesNotMatch(said(e), /not available on/);
});
