// ours-uninstall v3 — removing ONE daemon, and the non-interactive contract.
//
// Spec: installer-spec-v3 §§8-9. Pure, like every other stage: the caller
// injects the file reads and this returns a plan.
//
//   ours-uninstall [--state-dir PATH] [--purge] [--dry-run]
//
// `--state-dir` selects WHICH daemon to remove and defaults to ~/.ours. The
// uninstaller only ever touches that daemon and the components pointing at it.
//
// THE BIAS OF THIS WHOLE FILE IS TOWARD KEEPING THINGS. State is kept by default,
// a component's config file is kept even when its daemon keys are removed, and
// global packages are kept while any other daemon still needs them. The one
// destructive operation, --purge, is gated four separate ways (§8 step 5) because
// it deletes identity keys, and no other step here is irreversible.

import { join, resolve } from 'node:path';
import { unitNameForStateDir } from './plan.mjs';
import { tgConfigPath, coworkConfigPath } from './components.mjs';

/**
 * Marker recorded in config.json at CREATION time only, never on an update, so
 * `--purge` can tell a state directory this installer made from one that was
 * already there.
 *
 * SPEC GAP, flagged rather than assumed: §8 step 5 says purge applies "only when
 * this state directory was created by an installer run rather than pre-existing",
 * but nothing on disk records that today. This is the cheapest thing that does,
 * it is additive, and the merge in planDaemonConfig preserves unrelated keys. The
 * fail-safe direction is deliberate — no marker means NOT ours to purge, so a
 * hand-made or pre-existing ~/.ours can never be deleted by this flag.
 */
export const CREATED_BY = '@ours.network/install';
export function stateDirCreationMarker(now) {
  return { createdBy: CREATED_BY, createdAt: now };
}
export function wasCreatedByInstaller(config) {
  return Boolean(config && typeof config === 'object' && config.createdBy === CREATED_BY);
}

/**
 * §8 step 1 — refuse if a component still points at this daemon.
 *
 * Read the connector's and cowork's config files; if either names this daemon's
 * endpoint or its state directory, list them and stop. Exit 2, nothing removed.
 * The operator either repoints them or confirms their removal in the same run.
 *
 * Matching on EITHER the endpoint or the state directory is deliberate: a
 * half-written pair should still be caught, and the whole point of the pair is
 * that neither half alone is trustworthy.
 */
export function componentsPointingHere({ home, env = {}, endpoint, stateDir, readJson }) {
  const dir = resolve(stateDir);
  const found = [];
  const tg = readJson(tgConfigPath(home, env));
  if (tg && (tg.daemonUrl === endpoint || (typeof tg.daemonStateDir === 'string' && resolve(tg.daemonStateDir) === dir))) {
    found.push({ key: 'tg', config: tgConfigPath(home, env), endpoint: tg.daemonUrl ?? null, stateDir: tg.daemonStateDir ?? null });
  }
  const cowork = readJson(coworkConfigPath(home, env));
  const block = cowork && typeof cowork.daemon === 'object' && cowork.daemon !== null ? cowork.daemon : null;
  if (block && (block.endpoint === endpoint || (typeof block.stateDir === 'string' && resolve(block.stateDir) === dir))) {
    found.push({ key: 'cowork', config: coworkConfigPath(home, env), endpoint: block.endpoint ?? null, stateDir: block.stateDir ?? null });
  }
  return found;
}

/**
 * Strip a component's daemon keys while KEEPING the file. It also holds the
 * operator's bot token and settings, and those are not ours to delete.
 *
 * For cowork, removing the `daemon` block returns it to embedded mode. That is a
 * real behaviour change, not a cleanup, so the plan carries `behaviourChange` for
 * the screen to state BEFORE it happens.
 */
export function planComponentDetach(key, existing) {
  const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? { ...existing } : {};
  if (key === 'tg') {
    const removed = ['daemonUrl', 'daemonStateDir'].filter((k) => k in base);
    for (const k of removed) delete base[k];
    return { key, removed, config: base, keepsFile: true, behaviourChange: null };
  }
  const had = 'daemon' in base;
  delete base.daemon;
  return {
    key,
    removed: had ? ['daemon'] : [],
    config: base,
    keepsFile: true,
    behaviourChange: had ? 'cowork returns to embedded mode' : null,
  };
}

/**
 * §8 steps 3-4 — the boot service, then the daemon itself.
 *
 * Both delegate their refusals rather than reimplementing them: `ours daemon
 * uninstall-service` refuses to remove a unit not marked as CLI-managed, and
 * `ours daemon stop` refuses to signal a daemon it did not start. In the second
 * case the screen names the external launcher and the run CONTINUES — a daemon
 * someone else supervises is not a failure of this uninstall.
 */
export function planDaemonRemoval({ stateDir, cliStartedIt }) {
  const dir = resolve(stateDir);
  const unit = unitNameForStateDir(dir);
  return [
    {
      id: 'service',
      unit: unit.ok ? unit.unit : null,
      command: ['ours', 'daemon', 'uninstall-service', '--yes', '--state-dir', dir],
      note: 'refuses a unit not marked as CLI-managed',
    },
    cliStartedIt
      ? { id: 'stop', command: ['ours', 'daemon', 'stop', '--config', join(dir, 'config.json')] }
      : { id: 'stop-external', command: null, continues: true, note: 'this daemon was not started by the CLI; naming its launcher and continuing' },
  ];
}

/**
 * §8 step 5 — state. Kept unless every one of four gates opens.
 *
 * The gates, and why each exists:
 *   --purge given          — never the default; deleting identity keys is opt-in.
 *   interactive            — an unattended run never deletes state (§9).
 *   created by an installer— a pre-existing or hand-made directory is not ours.
 *   typed confirmation     — a y/N is too easy to answer wrongly for something
 *                            that destroys keys no peer can give back.
 *
 * Returns the exact directory, never a glob or a parent, and only when all four
 * are satisfied.
 */
export function planStatePurge({ stateDir, purge = false, assumeYes = false, config, typedConfirmation = null }) {
  const dir = resolve(stateDir);
  const keep = (reason) => ({ action: 'keep', stateDir: dir, reason, hint: 're-run with --purge to delete identities and history' });
  if (!purge) return keep('state is kept by default');
  if (assumeYes) return keep('state is never deleted non-interactively');
  if (!wasCreatedByInstaller(config)) {
    return keep(`${dir} was not created by an installer run; refusing to delete a directory this installer did not make`);
  }
  const expected = dir;
  if (typedConfirmation !== expected) {
    return {
      action: 'confirm-typed',
      stateDir: dir,
      expected,
      prompt: `This permanently deletes ${dir}, including the identity keys and message history of every identity in it. No peer can give them back.\nType the full path to confirm:`,
    };
  }
  return { action: 'purge', stateDir: dir, paths: [dir] };
}

/**
 * §8 step 6 — global packages are shared. Remove them only when no OTHER state
 * directory on this machine still has a daemon config; otherwise keep them and
 * say which daemon still needs them.
 */
export function planGlobalPackages({ stateDir, otherStateDirsWithConfig = [] }) {
  const dir = resolve(stateDir);
  const others = otherStateDirsWithConfig.map((d) => resolve(d)).filter((d) => d !== dir);
  if (others.length > 0) {
    return { action: 'keep', packages: [], stillNeededBy: others, reason: `still used by the daemon at ${others[0]}` };
  }
  return { action: 'remove', packages: ['@ours.network/cli', '@ours.network/mcp'], stillNeededBy: [] };
}

/**
 * The whole §8 order, refusing at step 1 rather than starting and stopping
 * half-way.
 */
export function planUninstall({ home, env = {}, endpoint, stateDir, purge = false, assumeYes = false, confirmedComponents = [], readJson, cliStartedIt = true, otherStateDirsWithConfig = [], typedConfirmation = null }) {
  const dir = resolve(stateDir);
  const pointing = componentsPointingHere({ home, env, endpoint, stateDir: dir, readJson });
  const unconfirmed = pointing.filter((p) => !confirmedComponents.includes(p.key));
  if (unconfirmed.length > 0) {
    return {
      action: 'refuse',
      exitCode: 2,
      reason: 'component-still-points-here',
      components: unconfirmed,
      removed: [],
      message: `${unconfirmed.map((p) => p.key).join(' and ')} still point at this daemon. Repoint them, or confirm their removal in the same run. Nothing was removed.`,
    };
  }
  return {
    action: 'uninstall',
    stateDir: dir,
    detach: pointing.map((p) => ({ key: p.key, service: [`ours-${p.key === 'tg' ? 'tg-connector' : 'cowork'}`, 'uninstall-service'] })),
    daemon: planDaemonRemoval({ stateDir: dir, cliStartedIt }),
    state: planStatePurge({ stateDir: dir, purge, assumeYes, config: readJson(join(dir, 'config.json')), typedConfirmation }),
    packages: planGlobalPackages({ stateDir: dir, otherStateDirsWithConfig }),
  };
}

// -----------------------------------------------------------------------------
// §9 — the non-interactive contract
// -----------------------------------------------------------------------------

/**
 * What each question answers to under OURS_ASSUME_YES.
 *
 * The two `false` entries are the point of the table: assume-yes never turns a
 * component on that was off, never MOVES one that already exists, and never
 * deletes state. It suppresses questions; it does not consent on the operator's
 * behalf to anything irreversible or to anything that changes where an existing
 * component is pointing.
 */
export const NON_INTERACTIVE_ANSWERS = {
  daemon: true,
  mcp: true,
  tg: false,
  cowork: false,
  repointExistingConnector: false,
  purge: false,
};

/**
 * OURS_ASSUME_YES suppresses questions; it NEVER suppresses a refusal. Every
 * refusal in this specification applies unchanged in non-interactive mode and
 * exits 2 without writing anything.
 */
export function refusalSurvivesAssumeYes(refusal) {
  return refusal && refusal.action === 'refuse' ? { ...refusal, exitCode: 2 } : refusal;
}
