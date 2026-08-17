// ours-install v3 — the orchestrator.
//
// This is the part that cannot be pure: it walks the flow, renders the screens
// and runs the commands. Everything it DECIDES comes from lib/target.mjs,
// lib/plan.mjs, lib/components.mjs, lib/rerun.mjs and lib/uninstall.mjs, which
// stay pure and separately tested.
//
// The seam is `effects`: every side effect the run can have arrives through one
// injected object, so the whole orchestration is testable without a socket, a
// filesystem, a subprocess or a terminal. That is not a testing convenience — it
// is what makes `--dry-run` trustworthy, because a dry run is the same walk with
// the mutating effects replaced by a recorder.
//
// Effects contract (all injected; the real ones live in lib/effects.mjs):
//   probe(port)            -> { ok: true, stateDir } | { ok: false, reason }
//   isTaken(port)          -> boolean
//   readJson(path)         -> object | null
//   readText(path)         -> string | null
//   writeJson(path, text)  -> void          (atomic; never called on a dry run)
//   run(cmd, args)         -> { ok, code, stdout }   (never on a dry run)
//   installedVersion(pkg)  -> string | null
//   out(line)              -> void
//   ask(prompt, default)   -> boolean       (never called when assumeYes)
//   now()                  -> number

import { join } from 'node:path';
import { parseInstallArgs, resolveTarget, InstallUsageError } from './target.mjs';
import { planDaemonConfig, planServiceInstall, serviceInstallCommand } from './plan.mjs';
import {
  COMPONENTS,
  planComponentSelection, planMcpAttachment, planTgAttachment, planCoworkAttachment,
  tgConfigPath, coworkConfigPath, summarizeComponentRun, componentSpec,
} from './components.mjs';
import { planHarnessPlugins, planFleet, planVoice, buildHandoffPromptV3 } from './extras.mjs';
import { summarizeRun } from './rerun.mjs';
import { detectPlatform, resolveChannel, validateBroker } from './logic.mjs';
import { daemonEnv } from './effects.mjs';
import { USAGE } from './usage.mjs';
import { ok, info, warn, heading, banner, box, c } from './ui.mjs';

export const EXIT_OK = 0;
export const EXIT_REFUSED = 2;

/**
 * A dry run prints what it WOULD do and performs no mutation. The prefix is the
 * existing installer's, kept so the two flows read the same.
 */
const wouldPrefix = (label) => `[dry-run] would: ${label}`;

/**
 * One mutating step. `dryRun` is checked HERE, once, rather than at each call
 * site — a side effect that forgets the check is the way a dry run stops being
 * one, and there is exactly one place to get it wrong.
 */
async function perform(effects, dryRun, label, thunk) {
  if (dryRun) {
    effects.out(info(wouldPrefix(label)));
    return { performed: false, dryRun: true };
  }
  const result = await thunk();
  effects.out(ok(label));
  return { performed: true, ...(result ?? {}) };
}

const reason = (error) => (error instanceof Error ? error.message : String(error));

/**
 * A step that is allowed to fail without ending the run.
 *
 * Everything after the daemon phase is an EXTRA: a harness plugin, ours-fleet,
 * voice. None of them is a reason to undo a daemon that came up correctly, and
 * v2's golden rule — never dead-end — is the same rule stated for a whole phase
 * rather than one harness. So a failure here is one honest line plus whatever
 * the caller wants to say about retrying, and the walk continues.
 */
async function attempt(effects, dryRun, label, thunk) {
  try {
    return { ok: true, ...(await perform(effects, dryRun, label, thunk)) };
  } catch (error) {
    effects.out(warn(`${label} — did not complete: ${reason(error)}`));
    return { ok: false, error };
  }
}

/**
 * The pair, for one child invocation, from a plan that says it can carry one.
 *
 * lib/extras.mjs states the INTENT (`env: { OURS_CONFIG }` or `{}`); daemonEnv
 * builds the whole thing. The two are deliberately not the same object: a plan
 * is pure and knows only the state directory, while a pair also needs the port,
 * and it is the half-pair — one name set, the rest defaulted to ~/.ours — that
 * silently attaches a child to a daemon the operator never chose.
 */
function pairFor(plan, target) {
  return plan && plan.env && Object.keys(plan.env).length > 0
    ? daemonEnv(target.stateDir, target.port)
    : undefined;
}

/**
 * The daemon half of a run: §§2-4. Returns the target decision plus the step
 * outcomes, or a refusal.
 */
export async function runDaemonPhase(args, effects) {
  const target = await resolveTarget({
    stateDir: args.stateDir,
    port: args.port,
    portExplicit: args.portExplicit,
    probe: effects.probe,
    readJson: effects.readJson,
    isTaken: effects.isTaken,
  });

  if (target.action === 'refuse') {
    effects.out(warn(`ours: refusing to continue — ${target.message}`));
    if (target.reason === 'foreign-daemon') {
      effects.out(info('Fix: re-run with --port for a free port, or with --state-dir naming the state directory that daemon actually owns.'));
    }
    if (target.reason === 'port-mismatch') {
      effects.out(info('Re-run without --port to use the recorded port. Nothing was written.'));
    }
    return { refused: target };
  }

  const dir = target.stateDir;
  const creating = target.action === 'create';
  effects.out(heading(creating ? `target ${dir} — creating a daemon here` : `target ${dir} — daemon found on port ${target.port}`));
  if (target.stalePidRecord) {
    effects.out(info(`a PID record names port ${target.stalePidRecord} but nothing answers there; treating it as stale`));
  }
  if (target.defaultPortHeldBy) {
    // Reported, never silent: the operator should know why this daemon did not
    // get the port they might have expected, and whose daemon has it.
    const held = target.defaultPortHeldBy;
    effects.out(info(`port ${held.port} is held by another ours daemon${held.stateDir ? ` (state directory ${held.stateDir})` : ''}; this one uses ${target.port}`));
  }
  if (target.reservedNotice) {
    effects.out(info(`port ${target.reservedNotice} is the Telegram connector's default port`));
  }

  // Asked ONCE, and only when this run is creating the daemon — an existing
  // daemon's broker is its own record, and re-asking would invite an operator to
  // change it from a screen that is not about changing it. Owner ruling: the
  // broker question stays in v3. It is orthogonal to --state-dir/--port, so it
  // does not violate spec §2's "nothing about a state directory or a port
  // appears in any prompt".
  if (creating) args.brokerUrl = await askBroker(args, effects);

  const steps = [];

  await perform(effects, args.dryRun, 'ours CLI installed (npm i -g @ours.network/cli)', () => effects.run('npm', ['i', '-g', '@ours.network/cli']));
  steps.push({ id: 'cli', changed: true, packageRefresh: true });

  // The config file — merged, never rewritten, and untouched when it already
  // matches. No provenance marker is written: the owner ruled that --purge works
  // on any state directory, so a `createdBy` key would have had no consumer, and
  // an unread key in a user's config file is future confusion for nothing.
  const configPath = join(dir, 'config.json');
  const merged = planDaemonConfig(
    effects.readJson(configPath),
    { port: target.port, stateDir: dir, brokerUrl: args.brokerUrl },
  );
  if (merged.changed) {
    await perform(effects, args.dryRun, `write ${configPath} (port ${target.port})`, () => effects.writeJson(configPath, merged.text));
  } else {
    effects.out(ok(`${configPath} already correct — not touched`));
  }
  steps.push({ id: 'config', changed: merged.changed, reason: merged.changed ? undefined : 'already correct' });

  if (creating) {
    await perform(effects, args.dryRun, `start the daemon on port ${target.port}`, () => effects.run('ours', ['daemon', 'start', '--config', configPath]));
    steps.push({ id: 'start', changed: true });
  }

  const service = await runServicePhase(args, effects, dir);
  if (service.refused) return { target, refused: service.refused, steps };
  steps.push(service.step);

  return { target, steps };
}

/**
 * The boot service: §4 step 4, including the legacy-unit case.
 *
 * A legacy ours-mcp unit is adopted SILENTLY, with one informational line naming
 * the file — the owner's decision. `--force` is passed ONLY here, only for a unit
 * positively identified as ours-mcp's, and never for one we cannot identify.
 */
export async function runServicePhase(args, effects, dir) {
  const plan = planServiceInstall({ stateDir: dir, home: effects.home, readText: effects.readText });
  if (plan.action === 'refuse') {
    effects.out(warn(`ours: refusing to continue — ${plan.message}`));
    return { refused: plan };
  }
  const adopting = plan.action === 'adopt';
  if (adopting) effects.out(info(plan.notice));
  const command = serviceInstallCommand({ stateDir: dir, adoptLegacyUnit: adopting });
  const outcome = await perform(effects, args.dryRun, `boot service ${plan.unit} installed and enabled`, () => effects.run(command[0], command.slice(1)));
  // Whether the unit actually changed is the CLI's answer, not ours: it does the
  // byte comparison and returns `changed` in its --json plan. Guessing here would
  // let a run that rewrote a unit report "nothing changed". Unreadable output is
  // treated as "changed", which is the safe direction for a summary line.
  const changed = readChanged(outcome.stdout);
  return { step: { id: 'service', changed, reason: changed ? undefined : 'unit unchanged' }, plan };
}

// The CLI's --json plan, when we can read it. Deliberately lenient: this is a
// summary line, not a decision, and it must never throw on unexpected output.
function readChanged(stdout) {
  if (typeof stdout !== 'string' || !stdout.trim()) return true;
  try {
    const parsed = JSON.parse(stdout);
    return typeof parsed?.changed === 'boolean' ? parsed.changed : true;
  } catch {
    return true;
  }
}

/**
 * Components: §5. A component that fails is reported with its retry command and
 * the run CONTINUES — a failed component is never a reason to undo a successful
 * one, or to undo the daemon.
 */
export async function runComponentPhase(args, effects, target) {
  const dir = target.stateDir;
  const endpoint = `http://127.0.0.1:${target.port}`;
  const isDefaultStateDir = dir === join(effects.home, '.ours');
  const chosen = planComponentSelection({
    answers: args.answers ?? {},
    installed: args.installed ?? {},
    assumeYes: args.assumeYes,
  });

  const results = [];
  for (const component of chosen) {
    if (component.action === 'skip' || component.action === 'leave-alone') {
      effects.out(info(`${component.label} — ${component.action === 'skip' ? 'not installed' : 'left as it is'}`));
      results.push({ key: component.key, state: 'skipped' });
      continue;
    }
    try {
      results.push(await attachComponent(component, { args, effects, dir, endpoint, isDefaultStateDir }));
    } catch (error) {
      // Reported with its reason and the exact manual command; the run continues.
      // The retry carries the CHANNEL — a nightly run that hands the operator a
      // stable retry command sends them straight into the split-brain install
      // this phase exists to avoid.
      const retry = `npm i -g ${componentSpec(component, args.channel)}`;
      effects.out(warn(`${component.label} failed: ${error instanceof Error ? error.message : String(error)}`));
      effects.out(info(`retry manually: ${retry}`));
      results.push({ key: component.key, state: 'failed', reason: String(error?.message ?? error), retry });
    }
  }
  return summarizeComponentRun(results);
}

async function attachComponent(component, { args, effects, dir, endpoint, isDefaultStateDir }) {
  if (component.key === 'mcp') {
    const plan = planMcpAttachment({ stateDir: dir, isDefaultStateDir, channel: args.channel });
    await perform(effects, args.dryRun, `install ${plan.install[3]}`, () => effects.run(plan.install[0], plan.install.slice(1)));
    if (Object.keys(plan.harnessEnv).length > 0) {
      effects.out(info(`harness registration carries OURS_CONFIG=${plan.harnessEnv.OURS_CONFIG}`));
    }
    return { key: 'mcp', state: 'installed' };
  }

  if (component.key === 'tg') {
    const path = tgConfigPath(effects.home, effects.env);
    const plan = planTgAttachment({
      existing: effects.readJson(path),
      endpoint,
      stateDir: dir,
      brokerUrl: args.brokerUrl,
      assumeYes: args.assumeYes,
      channel: args.channel,
    });
    if (plan.action === 'skip-repoint') {
      effects.out(info('the Telegram connector points at another daemon; never repointed non-interactively'));
      return { key: 'tg', state: 'skipped' };
    }
    if (plan.action === 'confirm-repoint') {
      // Moving a connector is not recoverable by re-running the way a replaced
      // unit file is: the operator's routes would be talking to a daemon they
      // never chose. So this one asks.
      if (!(await effects.ask(plan.prompt, false))) {
        effects.out(info('left where it is'));
        return { key: 'tg', state: 'skipped' };
      }
    }
    await perform(effects, args.dryRun, `install ${plan.install[3]}`, () => effects.run(plan.install[0], plan.install.slice(1)));
    if (plan.changed) {
      // Written BEFORE the service: install-service bakes these values into the
      // unit as environment, and environment outranks the config file after.
      await perform(effects, args.dryRun, `write ${path}`, () => effects.writeJson(path, `${JSON.stringify(plan.config, null, 2)}\n`));
    } else {
      effects.out(ok(`${path} already points here — not touched`));
    }
    await perform(effects, args.dryRun, 'Telegram connector service installed', () => effects.run(plan.service[0], plan.service.slice(1)));
    return { key: 'tg', state: 'installed' };
  }

  const path = coworkConfigPath(effects.home, effects.env);
  // cowork is the ONE component installed before its plan exists, because the
  // version floor applies to what is now on disk rather than what was requested
  // — so the spec is built here rather than read off the plan. It still goes
  // through componentSpec, so the channel reaches it like every other package.
  const spec = componentSpec(component, args.channel);
  await perform(effects, args.dryRun, `install ${spec}`, () => effects.run('npm', ['i', '-g', spec]));
  // The installed version is read AFTER installing, because the floor applies to
  // what is now on disk rather than what was requested. Read by the BARE package
  // name: `npm ls -g` knows nothing about the dist-tag it was installed from.
  const plan = planCoworkAttachment({
    existing: effects.readJson(path),
    endpoint,
    stateDir: dir,
    installedVersion: effects.installedVersion(component.pkg),
    channel: args.channel,
  });
  if (plan.action === 'refuse' || plan.action === 'leave-embedded') {
    effects.out(warn(`cowork: ${plan.message}`));
    return { key: 'cowork', state: 'skipped', reason: plan.reason };
  }
  if (plan.changed) {
    await perform(effects, args.dryRun, `write ${path}`, () => effects.writeJson(path, `${JSON.stringify(plan.config, null, 2)}\n`));
  } else {
    effects.out(ok(`${path} already points here — not touched`));
  }
  await perform(effects, args.dryRun, 'cowork service installed', () => effects.run(plan.service[0], plan.service.slice(1)));
  return { key: 'cowork', state: 'installed' };
}

/**
 * The broker question (v2's Step 0a, kept by the owner's ruling).
 *
 * Consent-first, with the undo built in: a mistaken custom address is one
 * keystroke back to the standard broker, because the alternative is an operator
 * whose agents cannot find each other and no obvious way back.
 */
export async function askBroker(args, effects) {
  const standard = args.brokerUrl;
  if (args.assumeYes) return standard;
  effects.out(heading('Your broker'));
  effects.out(info('Your agents connect through a "broker" — a shared meeting point that lets them find'));
  effects.out(info("each other. It's secure: your messages are end-to-end encrypted, so the broker never"));
  effects.out(info('sees what they say. Almost everyone uses the standard one — just press Enter.'));
  if (!(await effects.ask('Use a custom broker address?', false))) {
    effects.out(ok('using the standard broker.'));
    return standard;
  }
  const entered = String(await effects.askLine('Enter the broker address: ', '')).trim();
  const checked = validateBroker(entered);
  if (!entered || !checked.ok || checked.empty) {
    if (entered) effects.out(warn(`"${entered}" doesn't look like a ws:// address — using the standard broker.`));
    else effects.out(ok('using the standard broker.'));
    return standard;
  }
  if (await effects.ask(`Use "${checked.value}"?  (No = go back to the standard broker)`, true)) {
    effects.out(ok(`broker set to ${checked.value}.`));
    return checked.value;
  }
  effects.out(ok('using the standard broker.'));
  return standard;
}

/**
 * Pre-flight: the two disasters worth catching before anything is touched.
 *
 * Carried over from the v2 body deliberately. Native Windows and a Node older
 * than 20 are not "the install went badly", they are "this cannot work here",
 * and finding that out after the daemon package is on disk helps nobody.
 *
 * NOT carried over: v2 also exited when no harness was found. Under v3 the
 * daemon is the product and the harness plugins are one extra among several, so
 * a machine with no harness still gets a working daemon and is told what is
 * missing. That is a deliberate divergence from v2, recorded here rather than
 * discovered.
 */
export function runPreflight(effects) {
  effects.out(heading('Checking your machine'));
  const plat = detectPlatform({
    platform: effects.platform?.platform,
    release: effects.platform?.release ?? '',
    env: effects.env,
  });
  if (!plat.supported) {
    if (plat.os === 'windows') {
      effects.out(warn(`${plat.label} isn't supported directly yet.`));
      effects.out(info('Install this inside WSL (Windows Subsystem for Linux), then re-run there:'));
      effects.out(info('https://learn.microsoft.com/windows/wsl/install'));
    } else {
      effects.out(warn(`Platform "${plat.label}" isn't supported. ours runs on Linux, macOS, or WSL.`));
    }
    return { ok: false, platform: plat };
  }
  effects.out(ok(`Platform: ${plat.label} (supported)`));
  const version = String(effects.nodeVersion ?? '0');
  if (Number.parseInt(version.split('.')[0], 10) < 20) {
    effects.out(warn(`Node.js ${version} — ours needs v20 or newer. Update Node and re-run.`));
    return { ok: false, platform: plat, node: version };
  }
  effects.out(ok(`Node.js ${version}`));
  return { ok: true, platform: plat, node: version };
}

/**
 * The human identity: `ours-mcp create-root`, kept by the owner's ruling.
 *
 * It needs `ours-mcp` on PATH and a reachable daemon, so under v3 it lands here
 * — after the component phase installed the MCP server, not back in the daemon
 * phase where v2 had it. Already-exists is a friendly keep, never an error, and
 * an unreachable daemon gets the exact retry command rather than "ask your agent
 * later"; the hand-off's identity step is the fallback for both failures.
 */
export async function runIdentityPhase(args, effects, { target, mcpReady }) {
  effects.out(heading('Your human identity'));
  if (!mcpReady) {
    effects.out(info('this needs the MCP server, which this run did not install — re-run ours-install to add both.'));
    return { key: 'identity', label: 'Human identity', state: 'skipped', note: 'no MCP server' };
  }
  effects.out(info('This is you — the human. Your agents act on your behalf, and it lets you message'));
  effects.out(info('people. (Internally this is your ours root; you just give it a name.)'));

  const fallback = effects.username();
  const name = (args.assumeYes
    ? fallback
    : String(await effects.askLine(`What name should others see?  [${fallback}]: `, fallback) || fallback)).trim() || fallback;

  const env = daemonEnv(target.stateDir, target.port);
  if (args.dryRun) {
    effects.out(info(wouldPrefix(`ours-mcp create-root "${name}"`)));
    return { key: 'identity', label: 'Human identity', state: 'installed', note: name };
  }
  try {
    const result = await effects.run('ours-mcp', ['create-root', name], { env });
    const existing = String(result?.stdout ?? '').match(/already exists \("([^"]+)"\)/);
    if (existing) {
      effects.out(ok(`You already have a human identity ("${existing[1]}") — keeping it.`));
      return { key: 'identity', label: 'Human identity', state: 'current', note: existing[1] };
    }
    effects.out(ok(`Your human identity "${name}" is created.`));
    return { key: 'identity', label: 'Human identity', state: 'installed', note: name };
  } catch (error) {
    const text = reason(error);
    if (/already exists/.test(text)) {
      effects.out(ok('You already have a human identity — keeping it.'));
      return { key: 'identity', label: 'Human identity', state: 'current', note: 'existing identity kept' };
    }
    if (/not running|not reachable|ECONNREFUSED|connect/i.test(text)) {
      effects.out(warn("The daemon isn't reachable yet — couldn't create your human identity."));
      effects.out(info(`Fix: run 'ours daemon start --config ${env.OURS_CONFIG}', then 'ours-mcp create-root "${name}"'.`));
      return { key: 'identity', label: 'Human identity', state: 'failed', note: 'daemon not reachable' };
    }
    effects.out(warn(`Couldn't create your human identity: ${text.split('\n')[0]}`));
    effects.out(info(`Retry any time: 'ours-mcp create-root "${name}"'.`));
    return { key: 'identity', label: 'Human identity', state: 'failed', note: 'create-root failed' };
  }
}

/**
 * The harness plugins (spec §5's other half).
 *
 * Two things this phase must never do, both inherited rules rather than new
 * ones. It never DRIVES a command it could not identify — an alias or a wrapper
 * that would not answer `--version` is printed as manual steps instead. And it
 * never CLAIMS the pair travelled when it did not: Claude Code's and Codex's
 * registrations cannot carry a value, so for a non-default state directory they
 * get the exact export line and no promise. Hermes' writer is ours, so its
 * invocation carries the whole pair and the claim is true.
 */
export async function runHarnessPhase(args, effects, { target, isDefaultStateDir }) {
  effects.out(heading('Harness plugins'));
  const detected = await effects.detectHarnesses();
  for (const h of detected) {
    if (h.status === 'ok') effects.out(ok(`'${h.command ?? h.name}'  → ${h.detail ?? 'real program'} (its plugin can be installed)`));
    else if (h.status === 'alias') effects.out(warn(`'${h.command ?? h.name}'  → ${h.detail} (I won't call it — manual steps below)`));
    else if (h.status === 'unsafe') effects.out(warn(`'${h.command ?? h.name}'  → on your PATH but didn't answer safely (manual steps below)`));
    else effects.out(info(`'${h.command ?? h.name}'  → not installed (skipped)`));
  }
  if (detected.every((h) => h.status === 'absent')) {
    effects.out(info('No Claude Code, Codex or Hermes found — install one and re-run to wire it up.'));
    effects.out(info('Your daemon is unaffected; nothing else in this run depends on a harness.'));
    return [];
  }

  // Asked BEFORE planning, because the plan's `wanted` is the answer. Only a
  // harness we can actually drive is worth a question — the others are going to
  // print manual steps whatever the operator says.
  const answers = {};
  if (!args.assumeYes) {
    for (const h of detected) {
      if (h.status !== 'ok') continue;
      answers[h.name] = await effects.ask(`Install the ours plugin into ${h.label ?? h.name}?`, true);
    }
  }

  const plans = planHarnessPlugins({
    harnesses: detected.map((h) => ({ name: h.name, status: h.status })),
    stateDir: target.stateDir,
    isDefaultStateDir,
    channel: args.channel,
    assumeYes: args.assumeYes,
    answers,
  });

  const rows = [];
  for (const plan of plans) {
    const row = { key: plan.name, label: `${plan.label} plugin` };
    if (plan.action === 'skip') {
      if (plan.reason !== 'not installed') effects.out(info(`${plan.label} — ${plan.reason}`));
      rows.push({ ...row, state: 'skipped', note: plan.reason });
      continue;
    }
    if (plan.action === 'manual') {
      // NEVER a dead end: the plugin is still installable, by hand, and the run
      // says so instead of pretending the harness does not exist.
      effects.out(warn(`${plan.label} — ${plan.reason}; install it yourself with:`));
      for (const step of plan.manual) effects.out(info(`  ${step}`));
      rows.push({ ...row, state: 'skipped', note: plan.reason });
      continue;
    }

    const env = pairFor(plan, target);
    let failed = null;
    for (const step of plan.steps) {
      const outcome = await attempt(effects, args.dryRun, step.join(' '), () => effects.run(step[0], step.slice(1), env ? { env } : {}));
      if (!outcome.ok) { failed = outcome; break; }
    }
    if (failed) {
      effects.out(info(`${plan.label} can still be installed by hand:`));
      for (const step of plan.manual) effects.out(info(`  ${step}`));
      rows.push({ ...row, state: 'failed', note: 'install step failed' });
      continue;
    }
    if (plan.envLine) {
      // The honest line. §5's promise does NOT hold for this harness, and the
      // screen says exactly what is true and exactly what to do about it.
      effects.out(warn(`${plan.label}'s registration cannot carry a value, so it will attach to the DEFAULT daemon.`));
      effects.out(info(`Add this to your shell profile so it uses this one instead:  ${plan.envLine}`));
    }
    rows.push({ ...row, state: 'installed', note: plan.envLine ? 'needs the env line above' : 'ready' });
  }
  return rows;
}

/**
 * ours-fleet. The feature that needed zero code anywhere.
 *
 * `ours-fleet init` takes no daemon argument and reads no daemon config; fleet
 * resolves a daemon per role, from the role's own env. So the installer installs
 * it, runs its one-time host setup, and — for a non-default state directory —
 * SAYS the one fleet.yaml line. Saying it is the whole feature.
 */
export async function runFleetPhase(args, effects, { target, isDefaultStateDir }) {
  effects.out(heading('ours-fleet (your always-online agent team)'));
  effects.out(info('This makes your harnesses PERSISTENT: they stop being just a terminal session and'));
  effects.out(info('become always-online agents that survive a reboot.'));
  const wanted = args.assumeYes ? true : await effects.ask('Install it?', true);
  const plan = planFleet({
    stateDir: target.stateDir, isDefaultStateDir, wanted, channel: args.channel,
  });
  if (plan.action === 'skip') {
    effects.out(info('skipped cleanly — re-run ours-install any time to add it.'));
    return { key: 'fleet', label: plan.label, state: 'skipped' };
  }
  const install = await attempt(effects, args.dryRun, plan.install.join(' '), () => effects.run(plan.install[0], plan.install.slice(1)));
  const init = install.ok
    ? await attempt(effects, args.dryRun, `${plan.init.join(' ')} (one-time host setup: units, dirs, linger)`, () => effects.run(plan.init[0], plan.init.slice(1)))
    : install;
  if (!init.ok) {
    effects.out(info(`retry manually: ${plan.init.join(' ')}`));
    return { key: 'fleet', label: plan.label, state: 'failed', note: 'ours-fleet init failed' };
  }
  effects.out(ok('ours-fleet ready — the core ours plugin discovers every option through `ours-fleet docs`.'));
  if (plan.instruction) effects.out(info(plan.instruction));
  return { key: 'fleet', label: plan.label, state: 'installed', note: 'CLI + core-plugin discovery' };
}

/**
 * Voice transcription — and the restart beat the installer now owns.
 *
 * Under v3 `ours-mcp voice-setup` classifies every daemon as `external`, because
 * a v3 daemon is started by `ours daemon start` and leaves no ours-mcp pid
 * record. So voice-setup writes the config and returns, correctly declining to
 * restart a daemon it does not manage — and the restart nobody now owns is
 * this phase's, because the installer is the only process that knows the daemon
 * is CLI-managed. Failure never rolls the daemon back: voice-setup leaves the
 * prior config intact on its own failure path, so the recovery is a retry.
 */
export async function runVoicePhase(args, effects, { target, mcpReady }) {
  effects.out(heading('Voice messages'));
  const env = daemonEnv(target.stateDir, target.port);
  const ready = mcpReady && !args.dryRun ? await voiceReady(effects, env) : false;

  const offer = planVoice({
    mcpInstalled: mcpReady, ready, assumeYes: args.assumeYes, stateDir: target.stateDir, port: target.port,
  });
  if (offer.action === 'skip') {
    effects.out(offer.reason === 'already-configured' ? ok(offer.message) : info(offer.message));
    return {
      key: 'voice',
      label: 'Voice transcription',
      state: offer.reason === 'already-configured' ? 'current' : 'skipped',
      note: offer.reason === 'already-configured' ? 'configured' : offer.reason,
    };
  }

  effects.out(info('Voice notes can be transcribed by a provider you choose. Audio is sent to that'));
  effects.out(info('provider; use a self-hosted endpoint if it must stay local. The API key is hidden.'));
  if (!(await effects.ask('Set up voice transcription now?', true))) {
    const declined = planVoice({ mcpInstalled: mcpReady, ready, accepted: false, stateDir: target.stateDir, port: target.port });
    effects.out(info(declined.message));
    return { key: 'voice', label: 'Voice transcription', state: 'skipped', note: 'declined; offered again on re-run' };
  }

  if (args.dryRun) {
    effects.out(info(wouldPrefix(offer.setup.join(' '))));
    return { key: 'voice', label: 'Voice transcription', state: 'skipped', note: 'dry run' };
  }
  // Interactive on purpose: voice-setup owns the provider choice and the masked
  // key prompt, and the installer keeps no second implementation of either.
  const setup = await effects.runInteractive(offer.setup[0], offer.setup.slice(1), { env });
  if (!setup.ok) {
    effects.out(warn('Voice setup did not complete; no installer-side credential fallback was used.'));
    effects.out(info(`Run '${offer.setup.join(' ')}' directly to try again.`));
    return { key: 'voice', label: 'Voice transcription', state: 'failed', note: 'voice-setup did not complete' };
  }

  const applied = planVoice({
    mcpInstalled: mcpReady, ready, accepted: true, configChanged: true, stateDir: target.stateDir, port: target.port,
  });
  const restart = await attempt(effects, args.dryRun, applied.restart.join(' '), () => effects.run(applied.restart[0], applied.restart.slice(1)));
  if (!restart.ok) {
    effects.out(info(`the configuration is saved; apply it with: ${applied.retryHint}`));
    return { key: 'voice', label: 'Voice transcription', state: 'failed', note: 'saved, but the daemon did not restart' };
  }
  if (await voiceReady(effects, env)) {
    effects.out(ok('Voice transcription is ready; the API key remains hidden.'));
    return { key: 'voice', label: 'Voice transcription', state: 'installed', note: 'ready' };
  }
  effects.out(warn(`Voice configuration was saved, but readiness was not confirmed — check '${offer.statusCheck.join(' ')}'.`));
  return { key: 'voice', label: 'Voice transcription', state: 'failed', note: 'readiness not confirmed' };
}

// Read-only, and deliberately lenient: an unreadable answer is "not ready",
// which offers voice setup again rather than skipping it on a bad parse.
async function voiceReady(effects, env) {
  try {
    const result = await effects.run('ours-mcp', ['voice-status', '--json'], { env });
    return JSON.parse(String(result?.stdout ?? '').trim())?.ready === true;
  } catch {
    return false;
  }
}

/**
 * The final screen and the copy-paste hand-off.
 *
 * The hand-off is the installer's actual product: everything it could not do
 * conversationally is handed to an agent that can. Steps for pieces this run did
 * not install drop out and the rest renumber, so nobody is told to configure
 * something they do not have.
 */
export async function endScreen(args, effects, { summary, target, isDefaultStateDir, brokerUrl }) {
  const rule = '═'.repeat(64);
  effects.out('');
  effects.out(`  ${c.cyan(rule)}`);
  effects.out(`  ${c.bold('ours.network — install complete')}`);
  effects.out(`  ${c.gray(`State directory: ${target.stateDir}   •   Port: ${target.port}`)}`);
  effects.out(`  ${c.gray(`Broker: ${brokerUrl === effects.brokerUrl ? 'standard' : 'custom'}`)}`);
  effects.out(`  ${c.cyan(rule)}`);
  for (const row of summary) {
    const mark = row.state === 'failed' ? c.red('✗') : row.state === 'skipped' ? c.gray('·') : c.green('✓');
    const state = (row.state === 'installed' || row.state === 'current')
      ? (row.note || 'ready')
      : row.state === 'skipped'
        ? c.gray(`skipped${row.note ? ` (${row.note})` : ''}`)
        : c.red(`needs attention${row.note ? ` — ${row.note}` : ''}`);
    effects.out(`  ${mark} ${String(row.label).padEnd(26)}${(row.version ? `v${row.version}` : '').padEnd(9)}${state}`);
  }
  effects.out('');
  effects.out(summary.some((r) => r.state === 'failed')
    ? `  ${c.yellow('Some pieces need a hand — see the notes above; re-run ours-install after fixing.')}`
    : `  ${c.green('Everything installed cleanly. No problems.')}`);

  const has = (key) => summary.some((r) => r.key === key && (r.state === 'installed' || r.state === 'current'));
  const { text, empty } = buildHandoffPromptV3({
    identity: !has('identity'),
    fleet: has('fleet'),
    telegram: has('tg'),
    stateDir: target.stateDir,
    isDefaultStateDir,
  });
  if (empty) {
    effects.out('');
    effects.out(`  ${c.green("You're all set — open your harness and just start talking to your agent.")}`);
  } else {
    effects.out('');
    effects.out(`  ${c.gray('─'.repeat(64))}`);
    effects.out(`  ${c.bold('ONE LAST STEP')} — copy the prompt below and paste it into your agent.`);
    effects.out(`  ${c.gray('─'.repeat(64))}`);
    effects.out('');
    effects.out(box(text.split('\n'), 'paste this into your agent'));
    if (!args.dryRun && effects.clipboard(text)) effects.out(`  ${c.gray('(copied to your clipboard.)')}`);
  }
  effects.out('');
  effects.out(`  ${c.gray('Re-run  ')}${c.cyan('ours-install')}${c.gray('  any time to add a skipped piece or update.')}`);
  effects.out(`  ${c.cyan(rule)}`);
}

/**
 * The whole run. Returns an exit code: 0, or 2 for any refusal.
 *
 * The order is not arbitrary and is the one thing here worth reading twice:
 *
 *   daemon → components → identity → harness plugins → ours-fleet → voice
 *
 * The daemon comes first because everything else attaches to one. The COMPONENTS
 * come second because `ours-mcp` is what the identity step and the voice step
 * both invoke, and under v3 it is a component rather than the daemon — so
 * anything that shells out to it has to wait for this phase, which is exactly
 * why v2's placement of those two steps could not simply be carried across.
 *
 * Every refusal in this specification applies unchanged in non-interactive mode
 * and exits 2 without writing anything — OURS_ASSUME_YES suppresses questions,
 * never a refusal.
 */
export async function runInstall(argv, effects) {
  let args;
  try {
    args = parseInstallArgs(argv, effects.env, { home: effects.home });
  } catch (error) {
    if (error instanceof InstallUsageError) {
      effects.out(warn(`ours: ${error.message}`));
      return EXIT_REFUSED;
    }
    throw error;
  }
  if (args.help) { effects.out(USAGE); return EXIT_OK; }
  if (args.version) { effects.out(`ours-install v${effects.version ?? '?'}`); return EXIT_OK; }

  args.brokerUrl = args.brokerUrl ?? effects.brokerUrl;
  args.channel = resolveChannel(effects.env.OURS_CHANNEL ?? effects.env.OURS_INSTALL_CHANNEL);

  effects.out(banner());
  effects.out(heading(`ours: target ${args.stateDir}${args.portExplicit ? `, port ${args.port}` : ''}`));
  if (args.dryRun) effects.out(info('dry-run: nothing will be installed or changed'));

  // An unsupported platform is not a refusal of an incoherent selection, it is a
  // machine this cannot run on. v2 exited 0 there and so does this, so a script
  // that wrapped the old installer keeps its meaning.
  if (!runPreflight(effects).ok) return EXIT_OK;

  const daemon = await runDaemonPhase(args, effects);
  if (daemon.refused) return EXIT_REFUSED;
  const target = daemon.target;
  const isDefaultStateDir = target.stateDir === join(effects.home, '.ours');

  const summary = [{
    key: 'core',
    label: 'ours core (daemon)',
    state: target.action === 'create' ? 'installed' : 'current',
    note: `port ${target.port}`,
  }];

  const components = await runComponentPhase(args, effects, target);
  for (const component of COMPONENTS) {
    const state = components.installed.includes(component.key) ? 'installed'
      : components.failed.some((f) => f.key === component.key) ? 'failed' : 'skipped';
    summary.push({
      key: component.key,
      label: component.label,
      state,
      version: state === 'installed' && !args.dryRun ? (effects.installedVersion(component.pkg) ?? '') : '',
      note: components.failed.find((f) => f.key === component.key)?.reason,
    });
  }
  const mcpReady = components.installed.includes('mcp');

  summary.push(await runIdentityPhase(args, effects, { target, mcpReady }));
  summary.push(...await runHarnessPhase(args, effects, { target, isDefaultStateDir }));
  summary.push(await runFleetPhase(args, effects, { target, isDefaultStateDir }));
  summary.push(await runVoicePhase(args, effects, { target, mcpReady }));

  const changes = summarizeRun(daemon.steps);
  if (!changes.changedAnything) {
    effects.out(ok('everything already correct — nothing changed except refreshed packages'));
  }
  for (const failure of components.failed) {
    effects.out(warn(`${failure.key} did not install: ${failure.reason}`));
  }
  await endScreen(args, effects, { summary, target, isDefaultStateDir, brokerUrl: args.brokerUrl });
  return EXIT_OK;
}
