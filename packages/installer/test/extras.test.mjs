// ours-install v3 — the four retained extras (owner ruling 2026-08-17).
//
// Pure functions only: nothing here spawns, writes, probes or touches a
// terminal. The point of each test is a decision that is easy to get wrong in
// the direction of a SILENT half-pair — a harness or a fleet role attached to
// ~/.ours while the operator was told a different state directory was chosen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import {
  planHarnessPlugins, planFleet, planVoice, buildHandoffPromptV3,
  HARNESS_ENV_SUPPORT, CLAUDE_MARKET, CODEX_MARKET,
} from '../lib/extras.mjs';
import { buildHandoffPrompt } from '../lib/logic.mjs';

const HOME = '/home/me';
const OURS = resolve(HOME, '.ours');
const TG = resolve(HOME, '.ours-tg');
const TG_CFG = join(TG, 'config.json');

const all = (status = 'ok') => [
  { name: 'claude-code', status },
  { name: 'codex', status },
  { name: 'hermes', status },
];
const by = (plans, name) => plans.find((p) => p.name === name);

// ------------------------------------------------------------ harness plugins --

test('the default state directory changes NOTHING about a harness install', () => {
  // The majority case. No env, no extra line to paste, and the pair guarantee
  // holds trivially because ~/.ours is what every registration already resolves.
  const plans = planHarnessPlugins({ harnesses: all(), stateDir: OURS, isDefaultStateDir: true });
  for (const p of plans) {
    assert.equal(p.action, 'drive');
    assert.equal(p.envSupport, 'none');
    assert.deepEqual(p.env, {});
    assert.equal(p.envLine, null);
    assert.equal(p.claimsPair, true);
    assert.equal(p.requiresHermesEnvWriter, false);
  }
});

test('a non-default state directory: Hermes carries the pair, Claude and Codex only print it', () => {
  // Spec §5 promises the registration carries OURS_CONFIG. Two of the three
  // registrations cannot carry a value at all, so this pins WHICH one is real —
  // and pins that the other two never claim the guarantee.
  const plans = planHarnessPlugins({ harnesses: all(), stateDir: TG, isDefaultStateDir: false });

  const hermes = by(plans, 'hermes');
  assert.equal(hermes.envSupport, 'applied');
  assert.deepEqual(hermes.env, { OURS_CONFIG: TG_CFG });
  assert.equal(hermes.claimsPair, true);
  assert.equal(hermes.envLine, null, 'nothing to paste: it is applied');

  for (const name of ['claude-code', 'codex']) {
    const p = by(plans, name);
    assert.equal(p.envSupport, 'printed', `${name} cannot carry a value`);
    assert.deepEqual(p.env, {}, `${name} must never be handed an env it cannot apply`);
    assert.equal(p.envLine, `export OURS_CONFIG=${TG_CFG}`);
    assert.equal(p.claimsPair, false, `${name} must never claim spec §5's guarantee`);
  }
});

test("Hermes' applied pair is pinned to the writer that has to exist for it", () => {
  // The ruling makes Hermes real by adding an `env:` block to renderConfigBlock,
  // which is a packages/hermes change and NOT in this PR. If that never lands,
  // 'applied' is a lie — so the requirement is data, not a comment.
  const nonDefault = by(planHarnessPlugins({ harnesses: all(), stateDir: TG, isDefaultStateDir: false }), 'hermes');
  assert.equal(nonDefault.requiresHermesEnvWriter, true);
  const dflt = by(planHarnessPlugins({ harnesses: all(), stateDir: OURS, isDefaultStateDir: true }), 'hermes');
  assert.equal(dflt.requiresHermesEnvWriter, false, 'the default path needs no new writer');
  assert.equal(HARNESS_ENV_SUPPORT['claude-code'], 'printed');
  assert.equal(HARNESS_ENV_SUPPORT.codex, 'printed');
});

test('a harness we cannot drive NEVER dead-ends — it always gets manual steps', () => {
  // v2's golden rule, kept verbatim: alias/unsafe means "do not call it", never
  // "you cannot have the plugin".
  for (const status of ['alias', 'unsafe']) {
    const plans = planHarnessPlugins({ harnesses: all(status), stateDir: OURS, isDefaultStateDir: true });
    for (const p of plans) {
      assert.equal(p.action, 'manual', `${p.name}/${status}`);
      assert.ok(p.manual.length > 0, `${p.name} must still say how to do it by hand`);
      assert.ok(p.reason, 'and say why it is not being driven');
    }
  }
  assert.ok(by(planHarnessPlugins({ harnesses: all('alias'), stateDir: OURS, isDefaultStateDir: true }), 'claude-code')
    .manual.some((s) => s.includes(CLAUDE_MARKET)));
  assert.ok(by(planHarnessPlugins({ harnesses: all('alias'), stateDir: OURS, isDefaultStateDir: true }), 'codex')
    .manual.some((s) => s.includes(CODEX_MARKET)));
});

test('an absent harness is skipped, and a declined one is offered again on re-run', () => {
  const absent = planHarnessPlugins({ harnesses: all('absent'), stateDir: OURS, isDefaultStateDir: true });
  for (const p of absent) assert.equal(p.action, 'skip');

  const declined = planHarnessPlugins({
    harnesses: all(), stateDir: OURS, isDefaultStateDir: true, answers: { codex: false },
  });
  assert.equal(by(declined, 'codex').action, 'skip');
  assert.equal(by(declined, 'codex').offerOnRerun, true);
  assert.equal(by(declined, 'claude-code').action, 'drive', 'declining one does not decline the others');
});

test('nothing a harness plan drives ever calls the `hermes` binary', () => {
  // Hermes has no driven CLI; its install is npm + ours-hermes-install. Calling
  // a `hermes` command is the mistake this pins shut.
  const hermes = by(planHarnessPlugins({ harnesses: all(), stateDir: OURS, isDefaultStateDir: true }), 'hermes');
  for (const step of hermes.steps) assert.notEqual(step[0], 'hermes');
  assert.ok(hermes.steps.some((s) => s[0] === 'ours-hermes-install' && s.includes('--skip-daemon')));
});

// -------------------------------------------------------------------- fleet --

test('ours-fleet is configured by SAYING one line, not by writing anything', () => {
  // Fleet already resolves the daemon per role through OURS_CONFIG and friends.
  // The whole feature is telling the operator the fleet.yaml line.
  const plan = planFleet({ stateDir: TG, isDefaultStateDir: false });
  assert.equal(plan.action, 'install');
  assert.deepEqual(plan.writes, [], 'the installer writes no fleet config, ever');
  assert.deepEqual(plan.init, ['ours-fleet', 'init'], 'init takes no daemon argument');
  assert.deepEqual(plan.roleEnv, { OURS_CONFIG: TG_CFG });
  assert.match(plan.instruction, /fleet\.yaml/);
  assert.ok(plan.instruction.includes(`OURS_CONFIG: ${TG_CFG}`));
});

test('the default state directory needs no fleet.yaml instruction at all', () => {
  const plan = planFleet({ stateDir: OURS, isDefaultStateDir: true });
  assert.equal(plan.instruction, null);
  assert.deepEqual(plan.roleEnv, {});
});

test('ours-fleet is installed at @latest even on the nightly channel', () => {
  // It lives in its own repo and publishes no nightly tag; @nightly would 404
  // the whole install.
  assert.deepEqual(planFleet({ stateDir: OURS, isDefaultStateDir: true, channel: 'nightly' }).install,
    ['npm', 'i', '-g', '@ours.network/fleet@latest']);
});

// -------------------------------------------------------------------- voice --

test('voice setup is skipped when there is no ours-mcp to run it', () => {
  // voice-setup is an ours-mcp subcommand and v3 installs the MCP server as a
  // COMPONENT, so a run that declined it has nothing to call.
  const p = planVoice({ mcpInstalled: false, stateDir: OURS, port: 3050 });
  assert.equal(p.action, 'skip');
  assert.equal(p.reason, 'no-mcp');
  assert.equal(p.offerOnRerun, true);
  assert.equal(p.restartOwed, false);
});

test('the INSTALLER owns the restart beat, because a v3 daemon is always `external` to ours-mcp', () => {
  // transactVoiceConfig returns at `if (daemonState !== 'managed')` for every
  // CLI-started daemon: config written, nothing applied. So the restart has to
  // come from here, and it names `ours daemon restart --config`, never
  // `ours-mcp restart`.
  const p = planVoice({ mcpInstalled: true, ready: false, accepted: true, configChanged: true, stateDir: TG, port: 3061 });
  assert.equal(p.action, 'setup');
  assert.equal(p.restartOwed, true);
  assert.deepEqual(p.restart, ['ours', 'daemon', 'restart', '--config', TG_CFG]);
  assert.deepEqual(p.env, { OURS_CONFIG: TG_CFG });
  assert.deepEqual(p.setup, ['ours-mcp', 'voice-setup']);
  assert.deepEqual(p.statusCheck, ['ours-mcp', 'voice-status', '--json']);
  assert.ok(!JSON.stringify(p).includes('ours-mcp restart'), 'v2\'s restart command is dead under v3');
});

test('an unchanged voice config owes no restart', () => {
  // Bouncing a daemon nobody asked to bounce is a real cost: it is shared.
  const p = planVoice({ mcpInstalled: true, accepted: true, configChanged: false, stateDir: TG, port: 3061 });
  assert.equal(p.action, 'setup');
  assert.equal(p.restartOwed, false);
  assert.equal(p.restart, null);
});

test('voice is not offered when already configured, and never offered non-interactively', () => {
  const ready = planVoice({ mcpInstalled: true, ready: true, stateDir: OURS, port: 3050 });
  assert.equal(ready.action, 'skip');
  assert.equal(ready.reason, 'already-configured');
  assert.equal(ready.offerOnRerun, false, 'nothing left to offer');

  const auto = planVoice({ mcpInstalled: true, assumeYes: true, stateDir: OURS, port: 3050 });
  assert.equal(auto.action, 'skip');
  assert.equal(auto.reason, 'non-interactive');
  assert.equal(auto.offerOnRerun, true, "v2's contract: offered again on re-run");

  const no = planVoice({ mcpInstalled: true, accepted: false, stateDir: OURS, port: 3050 });
  assert.equal(no.reason, 'declined');
  assert.equal(no.offerOnRerun, true);
});

// ---------------------------------------------------------------- hand-off --

test('the default state directory produces the v2 hand-off text BYTE FOR BYTE', () => {
  // The agent on the other end of this prompt configures fleet roles and
  // harness environments. A stray line about a state directory the user never
  // chose is worse than no line at all.
  for (const flags of [
    { identity: true, fleet: true, telegram: true },
    { fleet: true },
    { identity: true, telegram: true },
  ]) {
    assert.equal(
      buildHandoffPromptV3({ ...flags, stateDir: OURS, isDefaultStateDir: true }).text,
      buildHandoffPrompt(flags).text,
    );
  }
});

test('a non-default state directory adds ONE preamble that names the config path', () => {
  const v3 = buildHandoffPromptV3({ fleet: true, telegram: true, stateDir: TG, isDefaultStateDir: false });
  const v2 = buildHandoffPrompt({ fleet: true, telegram: true });
  assert.ok(v3.text.endsWith(v2.text), 'the steps themselves are untouched');
  assert.ok(v3.text.startsWith('My ours daemon uses the state directory '));
  assert.ok(v3.text.includes(TG_CFG));
  assert.ok(v3.text.includes('OURS_CONFIG'));
  assert.equal(v3.empty, false);
});

test('nothing to finish means no prompt, on either state directory', () => {
  assert.deepEqual(buildHandoffPromptV3({ stateDir: TG, isDefaultStateDir: false }), { text: '', empty: true });
  assert.deepEqual(buildHandoffPromptV3({}), { text: '', empty: true });
});
