// ours-uninstall v3 stage 5 — removing one daemon (spec §8) and the
// non-interactive contract (§9). Pure: file reads injected. Nothing is removed,
// stopped or deleted by any test here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import {
  CREATED_BY, stateDirCreationMarker, wasCreatedByInstaller, componentsPointingHere,
  planComponentDetach, planDaemonRemoval, planStatePurge, planGlobalPackages,
  planUninstall, NON_INTERACTIVE_ANSWERS, refusalSurvivesAssumeYes,
} from '../lib/uninstall.mjs';
import { planDaemonConfig } from '../lib/plan.mjs';

const HOME = '/home/me';
const OURS = resolve(HOME, '.ours');
const TG = resolve(HOME, '.ours-tg');
const TG_CFG = join(HOME, '.ours-telegram', 'config.json');
const COWORK_CFG = join(HOME, '.ours-cowork', 'config.json');
const files = (map) => (path) => (Object.prototype.hasOwnProperty.call(map, path) ? map[path] : null);
const MADE_BY_US = { ...stateDirCreationMarker(1), port: 3050, stateDir: OURS };

// ------------------------------------------------ §8 step 1 — the refusal ----

test('a component still pointing here stops the run before anything is removed', () => {
  const readJson = files({ [TG_CFG]: { daemonUrl: 'http://127.0.0.1:3050', daemonStateDir: OURS, botToken: 's' } });
  const p = planUninstall({ home: HOME, endpoint: 'http://127.0.0.1:3050', stateDir: OURS, readJson });
  assert.equal(p.action, 'refuse');
  assert.equal(p.exitCode, 2);
  assert.equal(p.reason, 'component-still-points-here');
  assert.deepEqual(p.removed, [], 'nothing removed');
  assert.match(p.message, /Nothing was removed/);
});

test('EITHER half of the pair is enough to catch a component', () => {
  // A half-written pair should still be caught: the whole point of the pair is
  // that neither half alone is trustworthy.
  const byStateDir = componentsPointingHere({ home: HOME, endpoint: 'http://127.0.0.1:9999', stateDir: OURS, readJson: files({ [TG_CFG]: { daemonStateDir: OURS } }) });
  assert.equal(byStateDir.length, 1);
  const byEndpoint = componentsPointingHere({ home: HOME, endpoint: 'http://127.0.0.1:3050', stateDir: OURS, readJson: files({ [TG_CFG]: { daemonUrl: 'http://127.0.0.1:3050' } }) });
  assert.equal(byEndpoint.length, 1);
});

test('cowork is caught through its daemon block', () => {
  const found = componentsPointingHere({
    home: HOME, endpoint: 'http://127.0.0.1:3050', stateDir: OURS,
    readJson: files({ [COWORK_CFG]: { stateDir: '/home/me/.ours-cowork', daemon: { mode: 'external', endpoint: 'http://127.0.0.1:3050', stateDir: OURS } } }),
  });
  assert.deepEqual(found.map((f) => f.key), ['cowork']);
});

test("a component pointing at a DIFFERENT daemon does not block this uninstall", () => {
  const readJson = files({ [TG_CFG]: { daemonUrl: 'http://127.0.0.1:3051', daemonStateDir: TG } });
  const p = planUninstall({ home: HOME, endpoint: 'http://127.0.0.1:3050', stateDir: OURS, readJson });
  assert.equal(p.action, 'uninstall');
});

test('confirming a component in the same run lets the uninstall proceed', () => {
  const readJson = files({ [TG_CFG]: { daemonStateDir: OURS } });
  const p = planUninstall({ home: HOME, endpoint: 'http://127.0.0.1:3050', stateDir: OURS, readJson, confirmedComponents: ['tg'] });
  assert.equal(p.action, 'uninstall');
  assert.deepEqual(p.detach.map((d) => d.key), ['tg']);
});

// -------------------------------------------- §8 step 2 — detach, keep file --

test('detaching the connector removes only the daemon keys and KEEPS the file', () => {
  const p = planComponentDetach('tg', { daemonUrl: 'http://x', daemonStateDir: OURS, botToken: 'secret', stt: { provider: 'x' } });
  assert.deepEqual(p.removed.sort(), ['daemonStateDir', 'daemonUrl']);
  assert.equal(p.keepsFile, true, 'the file also holds the operator bot token and settings');
  assert.equal(p.config.botToken, 'secret');
  assert.deepEqual(p.config.stt, { provider: 'x' });
  assert.ok(!('daemonUrl' in p.config));
});

test('detaching cowork is a BEHAVIOUR CHANGE and says so before it happens', () => {
  const p = planComponentDetach('cowork', { stateDir: '/home/me/.ours-cowork', daemon: { mode: 'external' }, theme: 'dark' });
  assert.equal(p.behaviourChange, 'cowork returns to embedded mode');
  assert.equal(p.config.stateDir, '/home/me/.ours-cowork', "cowork's own state key is not the daemon's");
  assert.equal(p.config.theme, 'dark');
  assert.equal(planComponentDetach('cowork', { theme: 'dark' }).behaviourChange, null, 'no block, no change to announce');
});

// ------------------------------------------- §8 steps 3-4 — service, daemon --

test('the boot service and the daemon delegate their refusals rather than reimplementing them', () => {
  const [service, stop] = planDaemonRemoval({ stateDir: TG, cliStartedIt: true });
  assert.equal(service.unit, 'ours-tg.service', 'this daemon\'s unit, not the default one');
  assert.ok(service.command.includes('--state-dir') && service.command.includes(TG));
  assert.match(service.note, /refuses a unit not marked as CLI-managed/);
  assert.ok(stop.command.includes('--config'));
});

test('a daemon the CLI did not start is named, not signalled, and the run continues', () => {
  const [, stop] = planDaemonRemoval({ stateDir: OURS, cliStartedIt: false });
  assert.equal(stop.id, 'stop-external');
  assert.equal(stop.command, null, 'ours daemon stop refuses to signal a daemon it did not start');
  assert.equal(stop.continues, true, 'someone else supervising it is not a failure of this uninstall');
});

// ------------------------------------------------ §8 step 5 — state, purged --

test('state is KEPT by default, with the hint', () => {
  const p = planStatePurge({ stateDir: OURS, config: MADE_BY_US });
  assert.equal(p.action, 'keep');
  assert.match(p.hint, /--purge/);
});

test('--purge never deletes a state directory this installer did not create', () => {
  // Fail-safe direction: no marker means NOT ours to purge, so a hand-made or
  // pre-existing ~/.ours can never be deleted by this flag.
  const p = planStatePurge({ stateDir: OURS, purge: true, config: { port: 3050 }, typedConfirmation: OURS });
  assert.equal(p.action, 'keep');
  assert.match(p.reason, /was not created by an installer run/);
  assert.equal(wasCreatedByInstaller({ createdBy: CREATED_BY }), true);
  assert.equal(wasCreatedByInstaller(null), false);
});

test('--purge is never taken non-interactively', () => {
  const p = planStatePurge({ stateDir: OURS, purge: true, assumeYes: true, config: MADE_BY_US, typedConfirmation: OURS });
  assert.equal(p.action, 'keep');
  assert.match(p.reason, /never deleted non-interactively/);
  assert.equal(NON_INTERACTIVE_ANSWERS.purge, false);
});

test('--purge demands the full path TYPED, not a y/N', () => {
  const asked = planStatePurge({ stateDir: OURS, purge: true, config: MADE_BY_US });
  assert.equal(asked.action, 'confirm-typed');
  assert.equal(asked.expected, OURS);
  assert.match(asked.prompt, /identity keys and message history/);
  assert.match(asked.prompt, /No peer can give them back/);
  for (const wrong of ['y', 'yes', '', '/home/me/.our', `${OURS}/`]) {
    assert.equal(planStatePurge({ stateDir: OURS, purge: true, config: MADE_BY_US, typedConfirmation: wrong }).action, 'confirm-typed', `${JSON.stringify(wrong)} must not pass`);
  }
});

test('all four gates open → the exact directory, never a parent or a glob', () => {
  const p = planStatePurge({ stateDir: OURS, purge: true, config: MADE_BY_US, typedConfirmation: OURS });
  assert.equal(p.action, 'purge');
  assert.deepEqual(p.paths, [OURS]);
  assert.ok(!p.paths.some((x) => x.includes('*')), 'no globs');
  assert.ok(!p.paths.includes(HOME), 'never the parent');
});

test('the creation marker survives the config merge, so purge stays possible', () => {
  const created = { ...stateDirCreationMarker(1), port: 3050 };
  const merged = planDaemonConfig(created, { port: 3060, stateDir: OURS, brokerUrl: 'wss://b' });
  assert.equal(wasCreatedByInstaller(merged.config), true, 'an update must not erase how the directory came to exist');
});

// --------------------------------------------- §8 step 6 — global packages --

test('global packages are kept while another daemon still needs them', () => {
  const p = planGlobalPackages({ stateDir: OURS, otherStateDirsWithConfig: [OURS, TG] });
  assert.equal(p.action, 'keep');
  assert.deepEqual(p.stillNeededBy, [TG]);
  assert.match(p.reason, /still used by the daemon at/);
});

test('global packages are removed only when this was the last daemon', () => {
  const p = planGlobalPackages({ stateDir: OURS, otherStateDirsWithConfig: [OURS] });
  assert.equal(p.action, 'remove');
  assert.deepEqual(p.packages, ['@ours.network/cli', '@ours.network/mcp']);
});

// ------------------------------------------------------------------- §9 ------

test('assume-yes never turns a component on, never moves one, never deletes state', () => {
  assert.deepEqual(NON_INTERACTIVE_ANSWERS, {
    daemon: true, mcp: true, tg: false, cowork: false, repointExistingConnector: false, purge: false,
  });
});

test('assume-yes suppresses questions, never a refusal', () => {
  const refusal = { action: 'refuse', reason: 'component-still-points-here' };
  assert.equal(refusalSurvivesAssumeYes(refusal).exitCode, 2);
  assert.equal(refusalSurvivesAssumeYes({ action: 'uninstall' }).exitCode, undefined);
});
