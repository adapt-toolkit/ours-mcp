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
import { planUninstall, planComponentDetach, planStatePurge } from './uninstall.mjs';
import { tgConfigPath, coworkConfigPath } from './components.mjs';
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
  const probe = planUninstall({ home: effects.home, env: effects.env, endpoint, stateDir: dir, readJson: effects.readJson });
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
  for (const component of plan.detach) {
    const path = component.key === 'tg' ? tgConfigPath(effects.home, effects.env) : coworkConfigPath(effects.home, effects.env);
    const detach = planComponentDetach(component.key, effects.readJson(path));
    if (detach.behaviourChange) effects.out(warn(`${component.key}: ${detach.behaviourChange}`));
    await perform(effects, args.dryRun, `${component.service.join(' ')}`, () => effects.run(component.service[0], component.service.slice(1)));
    if (detach.removed.length > 0) {
      await perform(effects, args.dryRun, `remove ${detach.removed.join(', ')} from ${path} (file kept)`, () => effects.writeJson(path, `${JSON.stringify(detach.config, null, 2)}\n`));
    }
  }

  // 3-4. The boot service, then the daemon. Both delegate their refusals.
  for (const step of plan.daemon) {
    if (step.command === null) {
      effects.out(info(`${step.note} — nothing signalled`));
      continue;
    }
    await perform(effects, args.dryRun, step.command.join(' '), () => effects.run(step.command[0], step.command.slice(1)));
  }

  // 5. State. Last, because it is the only irreversible thing here.
  await runPurgePhase({ dir, purge, args, effects });

  // 6. Global packages, only when this was the last daemon.
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
