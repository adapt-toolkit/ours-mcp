// ours-install v3 stage 3 — component selection and attachment (spec §5, plus
// the repoint half of §7). Pure: current file contents and installed versions
// are injected. Nothing installs, writes, or starts anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import {
  COMPONENTS, COWORK_DAEMON_FLOOR, TG_REGISTRY_FILES, TG_ROUTE_FILES, TG_STATE_DIR_NAME,
  tgConfigPath, coworkConfigPath, planComponentSelection, planMcpAttachment,
  planTgAttachment, planCoworkAttachment, atLeastVersion, summarizeComponentRun, componentSpec,
} from '../lib/components.mjs';

const HOME = '/home/me';
const OURS = resolve(HOME, '.ours');
const TG = resolve(HOME, '.ours-tg');

// ----------------------------------------------------------------- selection --

test('defaults: MCP server yes, connector no, cowork no', () => {
  assert.deepEqual(COMPONENTS.map((c) => [c.key, c.default]), [['mcp', true], ['tg', false], ['cowork', false]]);
  const chosen = planComponentSelection({ assumeYes: true });
  assert.deepEqual(chosen.map((c) => [c.key, c.action]), [['mcp', 'install'], ['tg', 'skip'], ['cowork', 'skip']]);
});

test('declining an already-installed component never uninstalls it', () => {
  // "No" means "do not add", never "take it away". Removal is ours-uninstall.
  const chosen = planComponentSelection({ answers: { mcp: false, tg: false }, installed: { mcp: true, tg: true } });
  assert.equal(chosen.find((c) => c.key === 'mcp').action, 'leave-alone');
  assert.equal(chosen.find((c) => c.key === 'tg').action, 'leave-alone');
  assert.ok(!chosen.some((c) => /uninstall|remove/.test(c.action)));
});

test('an already-installed component defaults to keep', () => {
  const chosen = planComponentSelection({ installed: { tg: true } });
  assert.equal(chosen.find((c) => c.key === 'tg').action, 'keep', 'the question reads "keep it?"');
});

// ----------------------------------------------------------------------- MCP --

test('the MCP server gets no systemd unit — it is a per-session stdio proxy', () => {
  const p = planMcpAttachment({ stateDir: OURS, isDefaultStateDir: true });
  assert.equal(p.service, null);
  assert.deepEqual(p.harnessEnv, {}, 'the default state directory needs nothing extra');
});

test('a non-default state directory travels as a PAIR in the harness registration', () => {
  const p = planMcpAttachment({ stateDir: TG, isDefaultStateDir: false });
  assert.equal(p.harnessEnv.OURS_CONFIG, join(TG, 'config.json'));
});

// ------------------------------------------------------------------ connector --

test('THE CONNECTOR REGISTRY IS NEVER WRITTEN BY THE INSTALLER', () => {
  // The connector distinguishes its identities by walking its own state directory,
  // NOT by asking the daemon — a daemon's identity list is flat and carries no
  // attribution to the app that created it. Nothing here is reconstructible from
  // the daemon side, so anything the installer clears is gone for good, and the
  // route migration the owner is considering would lose the route -> identity
  // mapping it depends on.
  assert.deepEqual(TG_REGISTRY_FILES, ['bots.json']);
  assert.deepEqual(TG_ROUTE_FILES, ['identity.key', 'state_data.bin', 'connection.json']);
  const p = planTgAttachment({ existing: { botToken: 'secret' }, endpoint: 'http://127.0.0.1:3050', stateDir: OURS, brokerUrl: 'wss://b' });
  const written = JSON.stringify(p.config);
  for (const name of [...TG_REGISTRY_FILES, ...TG_ROUTE_FILES]) {
    assert.ok(!written.includes(name), `${name} is not the installer's to touch`);
  }
  assert.deepEqual(p.untouched, [...TG_REGISTRY_FILES, ...TG_ROUTE_FILES]);
  assert.equal(p.config.botToken, 'secret', 'every unrelated key is preserved');
});

test('the connector attachment sets exactly three keys and preserves the rest', () => {
  const existing = { botToken: 'secret', stt: { provider: 'x' }, controlPort: 3051 };
  const p = planTgAttachment({ existing, endpoint: 'http://127.0.0.1:3051', stateDir: TG, brokerUrl: 'wss://b' });
  assert.equal(p.action, 'attach');
  assert.deepEqual(p.changes.sort(), ['brokerUrl', 'daemonStateDir', 'daemonUrl']);
  assert.equal(p.config.daemonStateDir, TG, 'both daemon keys are always written together');
  assert.equal(p.config.botToken, 'secret');
  assert.equal(p.config.controlPort, 3051);
});

test('the connector config is not touched when all three already match', () => {
  const existing = { daemonUrl: 'http://127.0.0.1:3050', daemonStateDir: OURS, brokerUrl: 'wss://b', botToken: 's' };
  const p = planTgAttachment({ existing, endpoint: 'http://127.0.0.1:3050', stateDir: OURS, brokerUrl: 'wss://b' });
  assert.equal(p.action, 'unchanged');
  assert.equal(p.changed, false);
});

test('pointing the connector at a different daemon MOVES it, so it needs a yes', () => {
  const existing = { daemonUrl: 'http://127.0.0.1:3050', daemonStateDir: OURS, brokerUrl: 'wss://b' };
  const p = planTgAttachment({ existing, endpoint: 'http://127.0.0.1:3051', stateDir: TG, brokerUrl: 'wss://b' });
  assert.equal(p.action, 'confirm-repoint');
  assert.equal(p.from.daemonStateDir, OURS);
  assert.equal(p.to.daemonStateDir, TG);
  assert.match(p.prompt, /MOVES the connector; it does not add a second one/);
});

test('a connector is NEVER repointed non-interactively', () => {
  const existing = { daemonUrl: 'http://127.0.0.1:3050', daemonStateDir: OURS };
  const p = planTgAttachment({ existing, endpoint: 'http://127.0.0.1:3051', stateDir: TG, brokerUrl: 'wss://b', assumeYes: true });
  assert.equal(p.action, 'skip-repoint', 'assume-yes never turns a component on or moves one that exists');
});

test('the connector config is written BEFORE its service is installed', () => {
  // install-service bakes the resolved values into the unit as environment, and
  // environment outranks the config file afterwards.
  const p = planTgAttachment({ existing: {}, endpoint: 'http://127.0.0.1:3050', stateDir: OURS, brokerUrl: 'wss://b' });
  assert.ok(p.config, 'a config to write');
  assert.deepEqual(p.service, ['ours-tg-connector', 'install-service']);
});

test('config paths honour the documented env overrides', () => {
  assert.equal(tgConfigPath(HOME), join(HOME, TG_STATE_DIR_NAME, 'config.json'));
  assert.equal(tgConfigPath(HOME, { OURS_TG_CONFIG: '/elsewhere/c.json' }), '/elsewhere/c.json');
  assert.equal(coworkConfigPath(HOME), join(HOME, '.ours-cowork', 'config.json'));
});

// --------------------------------------------------------------------- cowork --

test('atLeastVersion is conservative: unparseable is too old', () => {
  assert.equal(atLeastVersion(COWORK_DAEMON_FLOOR, COWORK_DAEMON_FLOOR), true);
  assert.equal(atLeastVersion('0.4.1', COWORK_DAEMON_FLOOR), true, 'a release outranks a prerelease of the same version');
  assert.equal(atLeastVersion('0.5.0', COWORK_DAEMON_FLOOR), true);
  assert.equal(atLeastVersion('0.4.0', COWORK_DAEMON_FLOOR), false);
  assert.equal(atLeastVersion('0.4.1-nightly.20260815.aaaaaaa', COWORK_DAEMON_FLOOR), false, 'an earlier nightly is older');
  assert.equal(atLeastVersion('0.4.1-nightly.20260817.bbbbbbb', COWORK_DAEMON_FLOOR), true);
  for (const junk of [undefined, null, '', 'unknown', 'v0.4.1']) {
    assert.equal(atLeastVersion(junk, COWORK_DAEMON_FLOOR), false, `${JSON.stringify(junk)} must fail closed`);
  }
});

test('an older cowork is left embedded rather than handed a block it cannot parse', () => {
  const p = planCoworkAttachment({ existing: {}, endpoint: 'http://127.0.0.1:3050', stateDir: OURS, installedVersion: '0.4.0' });
  assert.equal(p.action, 'leave-embedded');
  assert.equal(p.reason, 'version-floor');
  assert.match(p.message, /leaving cowork embedded/);
});

test('a half-formed daemon block is refused, never written', () => {
  // cowork's boot is fail-closed; half a block stops it starting.
  assert.equal(planCoworkAttachment({ existing: {}, endpoint: '', stateDir: OURS, installedVersion: '0.5.0' }).action, 'refuse');
  assert.equal(planCoworkAttachment({ existing: {}, endpoint: 'http://x', stateDir: '', installedVersion: '0.5.0' }).action, 'refuse');
});

test("cowork's own top-level stateDir is left alone; only daemon.stateDir is ours", () => {
  const existing = { stateDir: resolve(HOME, '.ours-cowork'), theme: 'dark' };
  const p = planCoworkAttachment({ existing, endpoint: 'http://127.0.0.1:3051', stateDir: TG, installedVersion: '0.5.0' });
  assert.equal(p.action, 'attach');
  assert.equal(p.config.stateDir, resolve(HOME, '.ours-cowork'), "cowork's private state is not the daemon's");
  assert.equal(p.config.daemon.stateDir, TG);
  assert.equal(p.config.daemon.mode, 'external');
  assert.equal(p.config.theme, 'dark');
});

test('an already-correct cowork block is not rewritten', () => {
  const existing = { daemon: { mode: 'external', endpoint: 'http://127.0.0.1:3050', stateDir: OURS } };
  const p = planCoworkAttachment({ existing, endpoint: 'http://127.0.0.1:3050', stateDir: OURS, installedVersion: '0.5.0' });
  assert.equal(p.action, 'unchanged');
  assert.equal(p.changed, false);
});

// -------------------------------------------------------------------- failure --

test('one component failing does not stop the others or undo the daemon', () => {
  const summary = summarizeComponentRun([
    { key: 'mcp', state: 'installed' },
    { key: 'tg', state: 'failed', reason: 'npm exited 1', retry: 'npm i -g @ours.network/tg-connector' },
    { key: 'cowork', state: 'skipped' },
  ]);
  assert.deepEqual(summary.installed, ['mcp']);
  assert.deepEqual(summary.failed, [{ key: 'tg', reason: 'npm exited 1', retry: 'npm i -g @ours.network/tg-connector' }]);
  assert.deepEqual(summary.skipped, ['cowork']);
  assert.equal(summary.continued, true, 'a failed component is never a reason to undo a successful one');
});

// ------------------------------------------------------------------- channel --
//
// THE DEFECT THESE PIN. `args.channel` was resolved in the orchestrator and then
// reached only lib/extras.mjs's two planners, while these three packages were
// installed by their bare names — so `CHANNEL=nightly` installed the NIGHTLY
// Codex/Hermes plugins and NIGHTLY ours-fleet beside a STABLE MCP server. That is
// the split-brain deployment the channel exists to prevent, and it is the same
// class of bug the extras.mjs channel-map correction fixed for ours-fleet, one
// package over. All three packages publish a real `nightly` dist-tag, verified
// against the registry on 2026-08-17, so none of these pins can 404.

test('every component install carries the nightly tag on the nightly channel', () => {
  const mcp = planMcpAttachment({ stateDir: OURS, isDefaultStateDir: true, channel: 'nightly' });
  const tg = planTgAttachment({ existing: null, endpoint: 'http://127.0.0.1:3050', stateDir: OURS, brokerUrl: 'wss://b', channel: 'nightly' });
  const cowork = planCoworkAttachment({ existing: null, endpoint: 'http://127.0.0.1:3050', stateDir: OURS, installedVersion: '0.5.0', channel: 'nightly' });
  assert.deepEqual(mcp.install, ['npm', 'i', '-g', '@ours.network/mcp@nightly']);
  assert.deepEqual(tg.install, ['npm', 'i', '-g', '@ours.network/tg-connector@nightly']);
  assert.deepEqual(cowork.install, ['npm', 'i', '-g', '@ours.network/cowork@nightly']);
});

test('the stable channel installs the bare name, byte for byte what shipped before', () => {
  // `npm i -g pkg` and `npm i -g pkg@latest` are the same install, so the stable
  // path is deliberately left alone: the nightly channel was the broken case and
  // is the only one that changes.
  const mcp = planMcpAttachment({ stateDir: OURS, isDefaultStateDir: true });
  const tg = planTgAttachment({ existing: null, endpoint: 'http://127.0.0.1:3050', stateDir: OURS, brokerUrl: 'wss://b' });
  const cowork = planCoworkAttachment({ existing: null, endpoint: 'http://127.0.0.1:3050', stateDir: OURS, installedVersion: '0.5.0' });
  assert.deepEqual(mcp.install, ['npm', 'i', '-g', '@ours.network/mcp']);
  assert.deepEqual(tg.install, ['npm', 'i', '-g', '@ours.network/tg-connector']);
  assert.deepEqual(cowork.install, ['npm', 'i', '-g', '@ours.network/cowork']);
  assert.deepEqual(
    planMcpAttachment({ stateDir: OURS, isDefaultStateDir: true, channel: 'latest' }).install,
    ['npm', 'i', '-g', '@ours.network/mcp'],
    'an explicit latest is the same as none',
  );
});

test("a component's `pkg` stays BARE, because that is what reads a version back", () => {
  // Pinning the tag into `pkg` would make installedVersion('…/mcp@nightly')
  // return null forever: `npm ls -g` knows nothing about the dist-tag something
  // was installed from. That fails the cowork floor CLOSED and blanks the version
  // column — a regression that reads as "cowork is too old".
  for (const component of COMPONENTS) {
    assert.ok(!component.pkg.includes('@', 1), `${component.key}: pkg must carry no dist-tag`);
    assert.equal(componentSpec(component, 'nightly'), `${component.pkg}@nightly`);
    assert.equal(componentSpec(component, 'latest'), component.pkg);
  }
});

test('an unmapped channel falls back to latest rather than inventing a tag', () => {
  const p = planMcpAttachment({ stateDir: OURS, isDefaultStateDir: true, channel: 'banana' });
  assert.deepEqual(p.install, ['npm', 'i', '-g', '@ours.network/mcp'], 'never @banana — that would 404');
});
