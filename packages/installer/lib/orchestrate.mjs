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
  planComponentSelection, planMcpAttachment, planTgAttachment, planCoworkAttachment,
  tgConfigPath, coworkConfigPath, summarizeComponentRun,
} from './components.mjs';
import { summarizeRun } from './rerun.mjs';
import { ok, info, warn, heading } from './ui.mjs';

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

/**
 * The daemon half of a run: §§2-4. Returns the target decision plus the step
 * outcomes, or a refusal.
 */
export async function runDaemonPhase(args, effects) {
  const target = resolveTarget({
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
  if (target.reservedNotice) {
    effects.out(info(`port ${target.reservedNotice} is the Telegram connector's default port`));
  }

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
      const retry = `npm i -g ${component.pkg}`;
      effects.out(warn(`${component.label} failed: ${error instanceof Error ? error.message : String(error)}`));
      effects.out(info(`retry manually: ${retry}`));
      results.push({ key: component.key, state: 'failed', reason: String(error?.message ?? error), retry });
    }
  }
  return summarizeComponentRun(results);
}

async function attachComponent(component, { args, effects, dir, endpoint, isDefaultStateDir }) {
  if (component.key === 'mcp') {
    const plan = planMcpAttachment({ stateDir: dir, isDefaultStateDir });
    await perform(effects, args.dryRun, `install ${component.pkg}`, () => effects.run(plan.install[0], plan.install.slice(1)));
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
    await perform(effects, args.dryRun, `install ${component.pkg}`, () => effects.run(plan.install[0], plan.install.slice(1)));
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
  await perform(effects, args.dryRun, `install ${component.pkg}`, () => effects.run('npm', ['i', '-g', component.pkg]));
  // The installed version is read AFTER installing, because the floor applies to
  // what is now on disk rather than what was requested.
  const plan = planCoworkAttachment({
    existing: effects.readJson(path),
    endpoint,
    stateDir: dir,
    installedVersion: effects.installedVersion(component.pkg),
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
 * The whole run. Returns an exit code: 0, or 2 for any refusal.
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
  args.brokerUrl = args.brokerUrl ?? effects.brokerUrl;

  effects.out(heading(`ours: target ${args.stateDir}${args.portExplicit ? `, port ${args.port}` : ''}`));
  if (args.dryRun) effects.out(info('dry-run: nothing will be installed or changed'));

  const daemon = await runDaemonPhase(args, effects);
  if (daemon.refused) return EXIT_REFUSED;

  const components = await runComponentPhase(args, effects, daemon.target);
  const summary = summarizeRun(daemon.steps);
  if (!summary.changedAnything) {
    effects.out(ok('everything already correct — nothing changed except refreshed packages'));
  }
  for (const failure of components.failed) {
    effects.out(warn(`${failure.key} did not install: ${failure.reason}`));
  }
  return EXIT_OK;
}
