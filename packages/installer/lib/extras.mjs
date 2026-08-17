// ours-install v3 — the four retained extras, re-pointed at the v3 arrangement.
//
// Owner ruling 2026-08-17: the v3 installer KEEPS harness plugins, ours-fleet,
// voice setup and the copy-paste hand-off prompt. Spec v3's silence about them
// was an oversight, not a decision.
//
// They are not four more screens carried across, because v2 and v3 disagree
// about which package IS the daemon. In v2 @ours.network/mcp is the daemon and
// gets the unit; in v3 the daemon is the ours-sdk CLI and ours-mcp is a
// per-session stdio proxy with no unit. Each of the four had assumed the v2
// arrangement somewhere, and this module is where the new assumption lives.
//
// Pure, like target.mjs / plan.mjs / components.mjs: no I/O, no subprocess, no
// terminal. Every function takes what was observed and returns a plan; the
// orchestrator (a later PR) is what performs it.

import { join, resolve } from 'node:path';
import { pkgSpec } from './logic.mjs';

const cfgPath = (stateDir) => join(resolve(stateDir), 'config.json');

// -----------------------------------------------------------------------------
// §5 — harness plugins
// -----------------------------------------------------------------------------

export const CLAUDE_MARKET = 'adapt-toolkit/ours-claude-marketplace';
export const CODEX_MARKET = 'adapt-toolkit/ours-codex-marketplace';

export const HARNESSES = [
  { name: 'claude-code', label: 'Claude Code' },
  { name: 'codex', label: 'Codex' },
  { name: 'hermes', label: 'Hermes' },
];

/**
 * SPEC §5 PROMISES SOMETHING TWO OF THE THREE REGISTRATIONS CANNOT DO.
 *
 * §5: "For any other state directory the installer registers the harness MCP
 * entry with OURS_CONFIG=<state-dir>/config.json in its environment, so the pair
 * travels together." planMcpAttachment already returns exactly that harnessEnv —
 * and the orchestrator only PRINTS it. That is not an oversight to be fixed by
 * wiring it up harder; none of the three registrations can carry a value:
 *
 *   Claude Code  the marketplace plugin's mcpServers.ours is command+args, with
 *                no env key, and `claude plugin install` injects nothing per
 *                install.
 *   Codex        .mcp.json's env_vars is an allowlist of NAMES, not a value map
 *                (pinned by packages/codex/test/plugin-package.test.mjs). The
 *                value must already be in the ambient environment.
 *   Hermes       renderConfigBlock emits command/args/enabled — but it is OUR
 *                writer, so it can gain an env block.
 *
 * So §5's guarantee is ALREADY unmet today for every non-default state
 * directory, silently: the harness attaches to ~/.ours while the operator was
 * told the run targeted somewhere else. Owner ruling Q1 settles the shape:
 *
 *   default state directory   today's behaviour, byte for byte.
 *   Hermes, non-default       make it real — the pair is passed to
 *                             ours-hermes-install and written into the config.
 *   Claude / Codex, non-def   install the plugin (it is still the right plugin)
 *                             and PRINT the exact line the operator must add.
 *                             Never claim §5's guarantee in the screen text.
 *
 * Deliberately NOT done: registering a second, user-scoped `ours` MCP server via
 * `claude mcp add --env`. Two `ours` servers in front of one harness, and which
 * wins is not something anyone here has verified.
 */
export const HARNESS_ENV_SUPPORT = {
  // 'applied' — the pair is genuinely carried into the registration.
  // 'printed' — the operator is told the exact line and nothing is claimed.
  'claude-code': 'printed',
  codex: 'printed',
  hermes: 'applied',
};

const manualSteps = {
  'claude-code': (channel) => [
    `/plugin marketplace add ${CLAUDE_MARKET}`,
    '/plugin install ours',
  ],
  codex: (channel) => [
    `codex plugin marketplace add ${CODEX_MARKET}`,
    'codex plugin add ours@ours-codex-marketplace',
    `npm i -g ${pkgSpec('codex', channel)}`,
  ],
  hermes: (channel) => [
    `npm i -g ${pkgSpec('hermes', channel)}`,
    'ours-hermes-install',
  ],
};

const driveSteps = {
  'claude-code': (channel) => [
    ['claude', 'plugin', 'marketplace', 'add', CLAUDE_MARKET],
    ['claude', 'plugin', 'install', 'ours@ours.network'],
  ],
  codex: (channel) => [
    ['codex', 'plugin', 'marketplace', 'add', CODEX_MARKET],
    ['codex', 'plugin', 'add', 'ours@ours-codex-marketplace'],
    // Owner-mandated in v2 and kept: choosing the Codex plugin also installs the
    // ours-codex live launcher, in the same step.
    ['npm', 'i', '-g', pkgSpec('codex', channel)],
  ],
  // Hermes has no driven CLI: nothing here ever calls a `hermes` binary. Its
  // plugin install is npm + ours-hermes-install, which writes ~/.hermes.
  // --skip-daemon because in v3 the daemon is emphatically not ours-mcp's.
  hermes: (channel) => [
    ['npm', 'i', '-g', pkgSpec('hermes', channel)],
    ['ours-hermes-install', '--skip-daemon'],
  ],
};

/**
 * One plan per harness the caller observed.
 *
 * `harnesses` is [{ name, status }] where status is classifyHarnessProbe's
 * verdict ('ok' | 'alias' | 'unsafe' | 'absent'). Hermes is detected by its
 * config directory rather than a CLI, which is the caller's business; this only
 * consumes the verdict.
 *
 * The v2 golden rule is kept intact: 'alias' / 'unsafe' NEVER dead-end. A
 * harness we cannot safely drive still gets its manual steps printed, so the
 * plugin is still installable.
 *
 * `env` is what an invocation must carry, and it is EMPTY unless the harness can
 * genuinely apply it. `envLine` is what the operator is told. `claimsPair` is
 * false whenever the pair is only printed — the screen text renderer reads it so
 * §5's guarantee cannot be claimed where it does not hold.
 */
export function planHarnessPlugins({
  harnesses = [],
  stateDir,
  isDefaultStateDir,
  channel = 'latest',
  assumeYes = false,
  answers = {},
} = {}) {
  const config = stateDir ? cfgPath(stateDir) : null;
  return harnesses.map((h) => {
    const name = String(h?.name ?? '');
    const known = HARNESSES.find((k) => k.name === name);
    const label = known?.label ?? name;
    const status = String(h?.status ?? 'absent');
    const support = HARNESS_ENV_SUPPORT[name] ?? 'printed';
    const applies = !isDefaultStateDir && support === 'applied';

    const base = {
      name,
      label,
      status,
      // Default state directory → today's behaviour, byte for byte: no env
      // anywhere, nothing extra printed, nothing claimed.
      envSupport: isDefaultStateDir ? 'none' : support,
      env: applies ? { OURS_CONFIG: config } : {},
      envLine: isDefaultStateDir || applies ? null : `export OURS_CONFIG=${config}`,
      claimsPair: isDefaultStateDir ? true : applies,
      // Hermes' half of the ruling is only true once renderConfigBlock emits an
      // `env:` block. That is a packages/hermes change and NOT in this module's
      // PR, so it is pinned here rather than assumed: the orchestrator must not
      // ship 'applied' before the writer exists.
      requiresHermesEnvWriter: applies && name === 'hermes',
      manual: manualSteps[name] ? manualSteps[name](channel) : [],
    };

    if (!known) return { ...base, action: 'skip', reason: 'unknown harness' };
    if (status === 'absent') return { ...base, action: 'skip', reason: 'not installed' };

    const wanted = assumeYes ? true : answers[name] !== false;
    if (!wanted) return { ...base, action: 'skip', reason: 'declined', offerOnRerun: true };

    if (status === 'ok') return { ...base, action: 'drive', steps: driveSteps[name](channel) };
    return {
      ...base,
      action: 'manual',
      reason: status === 'alias' ? 'installed as an alias, not the real command' : 'found, but did not answer --version',
    };
  });
}

// -----------------------------------------------------------------------------
// ours-fleet — the one that needs zero code
// -----------------------------------------------------------------------------

/**
 * ours-fleet needs NO change in either repo, and the installer configures
 * nothing in it.
 *
 * `ours-fleet init` takes no daemon argument of any kind and never reads a
 * daemon config: it makes its directories, installs its own units and prints a
 * next step. Fleet resolves the ours daemon the same way the MCP client does —
 * OURS_CONFIG ?? ~/.ours/config.json, then OURS_PORT / OURS_STATE_DIR /
 * OURS_API_TOKEN — and it does so PER ROLE, through
 * resolveEndpoint({ ...process.env, ...role.env }). Different roles can already
 * target different daemons. Temp supervisors inherit the same four names.
 *
 * So for a non-default state directory the installer's ONLY job is to say the
 * one fleet.yaml line that points a role at the daemon this run created. Saying
 * it is the whole feature; anything more would be configuring a tool that is
 * already correct.
 */
export function planFleet({ stateDir, isDefaultStateDir, wanted = true, channel = 'latest' } = {}) {
  const config = stateDir ? cfgPath(stateDir) : null;
  const plan = {
    key: 'fleet',
    label: 'ours-fleet',
    // Always @latest: ours-fleet lives in its own repo and publishes no nightly
    // tag, so @nightly there would 404 the whole install. pkgSpec pins it.
    install: ['npm', 'i', '-g', pkgSpec('fleet', channel)],
    init: ['ours-fleet', 'init'],
    // Stated as data so a test can pin it: this feature writes no fleet config.
    writes: [],
    roleEnv: isDefaultStateDir ? {} : { OURS_CONFIG: config },
    instruction: isDefaultStateDir
      ? null
      : `fleet roles that should use this daemon need one line in fleet.yaml:\n    env: { OURS_CONFIG: ${config} }`,
  };
  return wanted ? { ...plan, action: 'install' } : { ...plan, action: 'skip', offerOnRerun: true };
}

// -----------------------------------------------------------------------------
// voice setup — the installer takes the restart beat
// -----------------------------------------------------------------------------

/**
 * WHY THE INSTALLER OWNS THE RESTART NOW (owner ruling Q2).
 *
 * cmdVoiceSetup computes `managed = runningPid() !== null` from ours-mcp's OWN
 * pid record. A v3 daemon is started by `ours daemon start`, which writes
 * <state-dir>/ours-cli-daemon.json — not that record. So runningPid() is null
 * and EVERY v3 daemon classifies as `external`. transactVoiceConfig then returns
 * at its `if (daemonState !== 'managed') return { ok: true, stage: 'write' }`:
 * config written, no apply, no restart, no readiness check, exit 0.
 *
 * Nothing goes wrong — voice-setup will not run `ours-mcp restart` against a
 * CLI-started daemon, which is right. But v2's entire restart protocol
 * (restartHandled, the exit-2 branch, "voice setup performed the required
 * restart") can only fire for a `managed` daemon, so carrying it across would
 * ship a branch that can never be taken. The beat it owned now has no owner, and
 * the installer is the only process that knows the daemon is CLI-managed.
 *
 * One phase, AFTER the component phase — voice-setup is an `ours-mcp`
 * subcommand and v3 installs @ours.network/mcp as a COMPONENT, so it is not on
 * PATH any earlier. The create path needs no special case: in v3 the first
 * `ours daemon start` already happened back in the daemon phase.
 *
 * FILED, NOT FIXED HERE: voice-setup's own hints still say `ours-mcp start` and
 * "restart its external launcher" (packages/core/src/cli.ts:542,547). Under v3
 * the answer is `ours daemon restart --config <cfg>`. That is a packages/core
 * change with its own blast radius and does not belong in an installer PR.
 */
export function planVoice({
  mcpInstalled = false,
  ready = false,
  assumeYes = false,
  accepted = null,
  configChanged = false,
  stateDir,
  port,
} = {}) {
  const config = stateDir ? cfgPath(stateDir) : null;
  const skip = (reason, message, extra = {}) => ({
    key: 'voice', action: 'skip', reason, message, offerOnRerun: true, restartOwed: false, ...extra,
  });

  if (!mcpInstalled) {
    return skip('no-mcp', 'voice setup needs the MCP server, which this run did not install — re-run ours-install to add both.');
  }
  if (ready) {
    return { key: 'voice', action: 'skip', reason: 'already-configured', message: 'voice transcription is already configured', offerOnRerun: false, restartOwed: false };
  }
  if (assumeYes) {
    return skip('non-interactive', 'voice setup is interactive and this run is not — re-run ours-install to configure it.');
  }
  if (accepted === false) {
    return skip('declined', 'skipped cleanly — re-run ours-install any time to configure voice.');
  }

  const env = config ? { OURS_CONFIG: config } : {};
  return {
    key: 'voice',
    action: 'setup',
    env,
    setup: ['ours-mcp', 'voice-setup'],
    statusCheck: ['ours-mcp', 'voice-status', '--json'],
    // The beat. Only owed when the config actually changed: an unchanged config
    // is not a reason to bounce a daemon somebody else may be using.
    restartOwed: Boolean(configChanged),
    restart: configChanged && config ? ['ours', 'daemon', 'restart', '--config', config] : null,
    // Never rolls the daemon back: voice-setup leaves the prior config intact on
    // its own failure path, so the recovery is a retry, not an undo.
    retryHint: config ? `ours daemon restart --config ${config}` : null,
    port: Number.isInteger(port) ? port : null,
  };
}

// -----------------------------------------------------------------------------
// the copy-paste hand-off prompt
// -----------------------------------------------------------------------------

/**
 * buildHandoffPrompt is already pure, already renumbers and already drops steps
 * for components that were not installed. Re-pointing it is one preamble.
 *
 * DEFAULT STATE DIRECTORY → THE TEXT IS UNCHANGED, BYTE FOR BYTE. That is the
 * overwhelming majority case and it is pinned by a test, because the agent on
 * the other end of this prompt configures fleet roles and harness environments,
 * and a stray line about a state directory the user never chose is a worse
 * outcome than no line at all.
 */
export function buildHandoffPromptV3({
  identity = false,
  fleet = false,
  telegram = false,
  stateDir = null,
  isDefaultStateDir = true,
} = {}) {
  const steps = [];
  if (identity) {
    steps.push(
      'Create my Ours human identity — this is me, the human; my agents act on\n'
      + '   my behalf. Ask me what name others should see, then create it.',
    );
  }
  if (fleet) {
    steps.push(
      'Set up my ours-fleet: ask me what agents I want in my fleet for\n'
      + '   PERMANENT use (a name + role/purpose for each), then create and\n'
      + '   configure those permanent fleet agents for me.',
    );
  }
  if (telegram) {
    steps.push(
      'Set up my Telegram bot: ask me for my bot\'s name and its token from\n'
      + '   @BotFather, register the bot, create a chat↔agent connection, and\n'
      + '   give me the invite link to send.',
    );
  }
  if (steps.length === 0) return { text: '', empty: true };

  const preamble = isDefaultStateDir || !stateDir
    ? ''
    : `My ours daemon uses the state directory ${resolve(stateDir)} (config\n${cfgPath(stateDir)}). When you configure anything for me — fleet roles,\nharness environments — set OURS_CONFIG to that path.\n\n`;

  const numbered = steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
  const text = preamble
    + 'I just installed the ours.network stack. Please help me finish setup, one\n'
    + 'step at a time, explaining as you go:\n\n'
    + numbered + '\n\n'
    + 'Do these in order, wait for my answers, and tell me if you need anything\n'
    + "from me. Don't assume — ask.";
  return { text, empty: false };
}
