// ours-uninstall v3 — the orchestrator.
//
//   ours-uninstall [--state-dir PATH] [--purge] [--dry-run]
//
// Same shape as lib/orchestrate.mjs: every side effect arrives through one
// injected `effects` object, every DECISION comes from lib/uninstall.mjs, which
// is pure and separately tested.
//
// This file removes things, so two properties matter more here than anywhere
// else in the installer:
//
//   NOTHING IS REMOVED AFTER A REFUSAL. Step 1 refuses before the first
//   mutation, so a run that stops leaves the daemon exactly as it was rather
//   than half-dismantled.
//
//   THE DESTRUCTIVE STEP IS LAST AND SEPARATELY GATED. --purge runs after
//   everything else has succeeded, needs four gates open, and is the only step
//   here that cannot be undone by re-running the installer.

import { join } from 'node:path';
import { parseInstallArgs, InstallUsageError } from './target.mjs';
import { planUninstall, planComponentDetach, planStatePurge, stripManagedBlock } from './uninstall.mjs';
import { tgConfigPath, coworkConfigPath } from './components.mjs';
import { configJournal, reportRollback } from './journal.mjs';
import { UNINSTALL_USAGE } from './usage.mjs';
import { ok, info, warn, heading } from './ui.mjs';

export const EXIT_OK = 0;
export const EXIT_REFUSED = 2;

async function perform(effects, dryRun, label, thunk) {
  if (dryRun) {
    effects.out(info(`[dry-run] would: ${label}`));
    return { performed: false };
  }
  await thunk();
  effects.out(ok(label));
  return { performed: true };
}

/**
 * Which components are being removed alongside this daemon. Asked once, before
 * anything is touched, so the §8 step 1 refusal can be resolved in the same run
 * rather than sending the operator away and back.
 *
 * Non-interactively the answer is NO — assume-yes never consents to removing
 * something on the operator's behalf, and step 1 then refuses, which is the
 * correct outcome for an unattended run pointed at a daemon still in use.
 */
export async function confirmComponentRemoval(pointing, { assumeYes, effects }) {
  if (pointing.length === 0 || assumeYes) return [];
  const confirmed = [];
  for (const component of pointing) {
    const answer = await effects.ask(
      `${component.key} points at this daemon (${component.config}). Remove its attachment too?`,
      false,
    );
    if (answer) confirmed.push(component.key);
  }
  return confirmed;
}

export async function runUninstall(argv, effects) {
  let args;
  try {
    args = parseInstallArgs(argv.filter((a) => a !== '--purge'), effects.env, { home: effects.home });
  } catch (error) {
    if (error instanceof InstallUsageError) {
      effects.out(warn(`ours: ${error.message}`));
      return EXIT_REFUSED;
    }
    throw error;
  }
  if (args.help) { effects.out(UNINSTALL_USAGE); return EXIT_OK; }
  if (args.version) { effects.out(`ours-uninstall v${effects.version ?? '?'}`); return EXIT_OK; }
  const purge = argv.includes('--purge');
  const dir = args.stateDir;
  const config = effects.readJson(join(dir, 'config.json'));
  const endpoint = `http://127.0.0.1:${typeof config?.port === 'number' ? config.port : 3050}`;

  effects.out(heading(`ours-uninstall --state-dir ${dir}`));
  if (args.dryRun) effects.out(info('dry-run: nothing will be removed or stopped'));

  // Ask first, mutate second. The question is about resolving the step-1
  // refusal, so it has to come before the plan that would refuse.
  // `readText` is passed alongside `readJson` so the planner can tell an ABSENT
  // component config from a CORRUPT one. Without it, effects.readJson's null
  // stands for both, and a file that will not parse reads as "no connector points
  // here" — which removes the daemon out from under a live connector.
  const probe = planUninstall({ home: effects.home, env: effects.env, endpoint, stateDir: dir, readJson: effects.readJson, readText: effects.readText });
  if (probe.action === 'refuse' && probe.reason === 'component-config-unreadable') {
    effects.out(warn(`ours: ${probe.message}`));
    return EXIT_REFUSED;
  }
  const pointing = probe.action === 'refuse' ? probe.components : [];
  const confirmedComponents = await confirmComponentRemoval(pointing, { assumeYes: args.assumeYes, effects });

  const plan = planUninstall({
    home: effects.home,
    env: effects.env,
    endpoint,
    stateDir: dir,
    purge,
    assumeYes: args.assumeYes,
    confirmedComponents,
    readJson: effects.readJson,
    readText: effects.readText,
    exists: effects.exists,
    cliStartedIt: effects.readJson(join(dir, 'ours-cli-daemon.json')) !== null,
    otherStateDirsWithConfig: effects.knownStateDirs(),
    typedConfirmation: null,
  });

  if (plan.action === 'refuse') {
    effects.out(warn(`ours: ${plan.message}`));
    return EXIT_REFUSED;
  }

  // 2. Component services and configs. The FILE is kept — it also holds the
  //    operator's bot token and settings, which were never ours.
  //
  // THE UNIT OF WORK HERE SPANS STEPS 2 THROUGH 4, and that is what makes it
  // different from the install-side journals. A detached connector's stripped
  // config says "no longer attached to this daemon", and only the daemon's actual
  // removal makes that true. If step 3 or 4 fails, the operator is left with a
  // stopped, detached connector NEXT TO A DAEMON THAT IS STILL THERE — a world the
  // bytes no longer describe.
  const journal = configJournal(effects, { dryRun: args.dryRun });
  const detached = [];
  for (const component of plan.detach) {
    const path = component.key === 'tg' ? tgConfigPath(effects.home, effects.env) : coworkConfigPath(effects.home, effects.env);
    const detach = planComponentDetach(component.key, effects.readJson(path));
    if (detach.behaviourChange) effects.out(warn(`${component.key}: ${detach.behaviourChange}`));
    await perform(effects, args.dryRun, `${component.service.join(' ')}`, () => effects.run(component.service[0], component.service.slice(1)));
    // Recorded whether or not its config changed: the SERVICE was stopped either
    // way, so a rollback owes it a re-apply either way.
    detached.push({ key: component.key, path, service: [component.service[0], 'install-service'] });
    if (detach.removed.length > 0) {
      journal.snapshot(path);
      await perform(effects, args.dryRun, `remove ${detach.removed.join(', ')} from ${path} (file kept)`, () => effects.writeJson(path, `${JSON.stringify(detach.config, null, 2)}\n`));
    }
  }

  // 3-4. The boot service, then the daemon. Both delegate their refusals.
  try {
    for (const step of plan.daemon) {
      if (step.command === null) {
        effects.out(info(`${step.note} — nothing signalled`));
        continue;
      }
      await perform(effects, args.dryRun, step.command.join(' '), () => effects.run(step.command[0], step.command.slice(1)));
    }
  } catch (error) {
    await rollBackDetach(effects, journal, detached, args);
    throw error;
  }

  // 5. The harness plugins the installer wrote.
  await runPluginPhase(plan.plugins, { args, effects });

  // 6. State. Last, because it is the only irreversible thing here.
  await runPurgePhase({ dir, purge, args, effects });

  // 7. Global packages, only when this was the last daemon.
  if (plan.packages.action === 'keep') {
    effects.out(info(`@ours.network/cli kept — ${plan.packages.reason}`));
  } else {
    for (const pkg of plan.packages.packages) {
      await perform(effects, args.dryRun, `npm rm -g ${pkg}`, () => effects.run('npm', ['rm', '-g', pkg]));
    }
  }
  return EXIT_OK;
}

/**
 * Undo a detach when the daemon it was detaching FROM did not go away.
 *
 * THIS ONE NEEDS A COMMAND, NOT JUST BYTES, and that is the whole reason it is a
 * separate function from the install side's rollback. The detach stopped the
 * connector's service before stripping its config, so restoring the bytes under a
 * stopped service is a HALF rollback — and half-states are exactly what this
 * feature exists to eliminate. The config goes back and then `install-service` is
 * re-applied, which is what the nightly uninstaller does
 * (lib/nightly-uninstall.mjs `rollbackConnectorLifecycles`), rather than a second
 * approach invented here.
 *
 * Every failure inside the recovery is REPORTED and none is thrown: the caller is
 * already on a failure path, and a recovery failure must never be what the
 * operator sees instead of the real fault. The original error is what propagates.
 */
export async function rollBackDetach(effects, journal, detached, args) {
  if (args.dryRun || detached.length === 0) return { restored: [], reapplied: [], failed: [] };
  effects.out(warn('the daemon was not removed, so the connectors are still attached to it — putting them back'));
  const outcome = journal.restoreAll();
  const reapplied = [];
  const failed = [];
  for (const component of detached.slice().reverse()) {
    try {
      await effects.run(component.service[0], component.service.slice(1));
      effects.out(ok(`${component.service.join(' ')} — ${component.key} is attached and running again`));
      reapplied.push(component.key);
    } catch (error) {
      failed.push(component.key);
      effects.out(warn(`could NOT re-apply ${component.key}'s service: ${error instanceof Error ? error.message : String(error)} — its config is back but the service is down; run '${component.service.join(' ')}' yourself`));
    }
  }
  reportRollback(effects, outcome, { packagesInstalled: false });
  return { ...outcome, reapplied, failed };
}

/**
 * The harness plugins: the managed config blocks, the ours skills directories,
 * and the plugin launchers on npm.
 *
 * Without this, a v3 uninstall is a capability REGRESSION against the v2 one —
 * it would remove the daemon and leave every harness still advertising ours
 * tools that no longer resolve.
 *
 * Two rules, both inherited rather than invented. A config file is edited only
 * when both our sentinels are found, and an unterminated block is REPORTED and
 * left alone rather than truncated to end-of-file (which is what v2 did, and it
 * would take everything the user wrote after our block with it). And the whole
 * phase is skipped while another daemon is still on this machine, because its
 * harnesses still need these plugins — the same condition that keeps the global
 * packages, decided once.
 */
export async function runPluginPhase(plugins, { args, effects }) {
  effects.out(heading('Harness plugins'));
  for (const step of plugins.manual) {
    // Never a dead end, and never a claim: Claude Code's plugin is not ours to
    // remove, so the run says so and prints the two commands that do it.
    effects.out(info(`${step.label} — ${step.reason}. Inside Claude Code, run:`));
    for (const command of step.steps) effects.out(info(`  ${command}`));
  }
  if (plugins.action === 'keep') {
    effects.out(info(`harness plugins kept — ${plugins.reason}`));
    return;
  }
  if (plugins.harnesses.length === 0) {
    effects.out(info('no Hermes or Codex plugin files found — nothing of ours to remove'));
    return;
  }

  for (const harness of plugins.harnesses) {
    for (const block of harness.blocks) {
      const before = effects.readText(block.path);
      if (before === null) continue;
      const stripped = stripManagedBlock(before, block.markers);
      if (stripped.action === 'absent') {
        effects.out(info(`${block.path} carries no ours block — left untouched`));
        continue;
      }
      if (stripped.action === 'refuse') {
        effects.out(warn(`${block.path}: ${stripped.reason}. Remove it by hand.`));
        continue;
      }
      await perform(effects, args.dryRun, `remove the ours managed block from ${block.path} (file kept)`, () => effects.writeText(block.path, stripped.text));
    }
    for (const dir of harness.dirs) {
      if (!effects.exists(dir)) continue;
      await perform(effects, args.dryRun, `remove ${dir}`, () => effects.removeDir(dir));
    }
    for (const file of harness.files) {
      if (!effects.exists(file)) continue;
      await perform(effects, args.dryRun, `remove ${file}`, () => effects.removeFile(file));
    }
  }
}

/**
 * --purge, gated four ways and asked for by typing the full path.
 *
 * The typed answer is compared by the pure planner, not here, so the comparison
 * cannot drift from the one the tests pin. A wrong or empty answer keeps the
 * state directory — there is no retry loop, because a second chance at deleting
 * identity keys is not a kindness.
 */
export async function runPurgePhase({ dir, purge, args, effects }) {
  const asked = planStatePurge({ stateDir: dir, purge, assumeYes: args.assumeYes, exists: effects.exists });
  if (asked.action === 'keep') {
    effects.out(info(`state ${dir} kept — ${asked.reason}`));
    if (!purge) effects.out(info(asked.hint));
    return { purged: false };
  }
  const typed = await effects.askLine(asked.prompt);
  const decided = planStatePurge({ stateDir: dir, purge, assumeYes: args.assumeYes, exists: effects.exists, typedConfirmation: typed });
  if (decided.action !== 'purge') {
    effects.out(info(`state ${dir} kept — the typed path did not match`));
    return { purged: false };
  }
  await perform(effects, args.dryRun, `delete ${dir} and everything in it`, () => effects.removeDir(dir));
  return { purged: !args.dryRun };
}
