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
// destructive operation, --purge, is separately gated (§8 step 5) because
// it deletes identity keys, and no other step here is irreversible.

import { join, resolve } from 'node:path';
import { unitNameForStateDir } from './plan.mjs';
import { tgConfigPath, coworkConfigPath } from './components.mjs';

/**
 * Does this directory even look like an ours state directory?
 *
 * WHY THIS EXISTS. The owner removed the "created by an installer run" gate —
 * purge means purge, on any state directory. That was a deliberate ruling and
 * this does not reintroduce it: this asks "is this a state directory at all",
 * not "is it ours". With provenance gone, the typed path would otherwise be the
 * only thing between `ours-uninstall --state-dir ~ --purge` and a deleted home
 * directory, and a typed path is no protection against a path typed exactly as
 * intended but meant differently.
 *
 * A directory qualifies if it carries any of the artefacts only a daemon writes.
 * Absent all of them, purge refuses and says why — the operator can still delete
 * the directory themselves, which is the right place for that decision.
 */
export const STATE_DIR_EVIDENCE = ['config.json', 'daemon-token', 'ours-cli-daemon.json', 'root.json'];
export function looksLikeStateDir(stateDir, exists) {
  return STATE_DIR_EVIDENCE.some((name) => exists(join(resolve(stateDir), name)));
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
 * §8 step 5 — state. Kept unless every gate opens.
 *
 *   --purge given      — never the default; deleting identity keys is opt-in.
 *   interactive        — an unattended run never deletes state (§9).
 *   looks like a state directory — see looksLikeStateDir.
 *   typed confirmation — the full path, not a y/N. The owner removed the
 *                        provenance condition, not the deliberateness, and with
 *                        provenance gone this is the last thing standing between
 *                        a mistyped command and someone's identity keys.
 *
 * Returns the exact directory, never a glob or a parent, and only when every gate
 * is satisfied.
 */
export function planStatePurge({ stateDir, purge = false, assumeYes = false, exists = () => true, typedConfirmation = null }) {
  const dir = resolve(stateDir);
  const keep = (reason) => ({ action: 'keep', stateDir: dir, reason, hint: 're-run with --purge to delete identities and history' });
  if (!purge) return keep('state is kept by default');
  if (assumeYes) return keep('state is never deleted non-interactively');
  if (!looksLikeStateDir(dir, exists)) {
    return keep(`${dir} does not look like an ours state directory (none of ${STATE_DIR_EVIDENCE.join(', ')}); refusing to delete it`);
  }
  if (typedConfirmation !== dir) {
    return {
      action: 'confirm-typed',
      stateDir: dir,
      expected: dir,
      prompt: `This permanently deletes ${dir} and everything in it, including the identity keys and message history of every identity there. Those keys exist nowhere else and no peer can give them back.\nType the full path to confirm:`,
    };
  }
  return { action: 'purge', stateDir: dir, paths: [dir] };
}

/**
 * §8 step 6 — global packages are shared. Remove them only when no OTHER state
 * directory on this machine still has a daemon config; otherwise keep them and
 * say which daemon still needs them.
 */
export function planGlobalPackages({ stateDir, otherStateDirsWithConfig = [], pluginPackages = [] }) {
  const dir = resolve(stateDir);
  const others = otherStateDirsWithConfig.map((d) => resolve(d)).filter((d) => d !== dir);
  if (others.length > 0) {
    return { action: 'keep', packages: [], stillNeededBy: others, reason: `still used by the daemon at ${others[0]}` };
  }
  // The harness-plugin launchers follow the SAME rule, not a second one: they
  // speak to a daemon through ours-mcp, so a second daemon still on the machine
  // still needs them, and the one condition above already decides that.
  return { action: 'remove', packages: ['@ours.network/cli', '@ours.network/mcp', ...pluginPackages], stillNeededBy: [] };
}

// -----------------------------------------------------------------------------
// §8 — the harness plugins the installer wrote
// -----------------------------------------------------------------------------

/**
 * The sentinels the plugin installers stamp around everything they write. They
 * are the ONLY thing that makes a block removable: without them we would be
 * editing a config file on a guess.
 */
export const YAML_BLOCK = { start: '# >>> ours.network plugin (managed block)', end: '# <<< ours.network plugin' };
export const MD_BLOCK = { start: '<!-- >>> ours.network plugin (managed block) -->', end: '<!-- <<< ours.network plugin -->' };

/**
 * Remove OUR block from a config file, or refuse.
 *
 * SAME IDENTIFICATION DISCIPLINE AS THE SYSTEMD UNIT, and for the same reason.
 * The installer refuses to overwrite a unit it cannot positively identify rather
 * than guessing; this refuses to edit a config it cannot positively identify.
 * Three outcomes, and the third is the one that matters:
 *
 *   absent  — no start sentinel. The file is not ours to edit; left untouched.
 *   strip   — both sentinels present. Exactly the delimited span is removed.
 *   refuse  — a start sentinel with NO end. v2 deleted to end-of-file here,
 *             which would take everything the user added after our block with
 *             it. An unterminated block is damage we cannot bound, so it is
 *             reported and left alone.
 */
export function stripManagedBlock(text, markers) {
  if (typeof text !== 'string' || !text.includes(markers.start)) {
    return { action: 'absent', reason: 'no ours managed block in this file' };
  }
  const lines = text.split('\n');
  const out = [];
  let inside = false;
  let closed = false;
  for (const line of lines) {
    if (!inside && line.includes(markers.start)) { inside = true; continue; }
    if (inside) {
      if (line.includes(markers.end)) { inside = false; closed = true; }
      continue;
    }
    out.push(line);
  }
  if (!closed) {
    return {
      action: 'refuse',
      reason: 'the ours managed block has no closing marker; refusing to guess where it ends',
    };
  }
  return { action: 'strip', text: out.join('\n') };
}

/**
 * What the harness-plugin half of an uninstall removes.
 *
 * `lastDaemon` is the same condition planGlobalPackages decides on, passed in
 * rather than recomputed: while another daemon is still on this machine its
 * harnesses still need their plugins, so nothing here is touched at all.
 *
 * Claude Code is deliberately manual-only. Its plugin lives in the in-app
 * marketplace, and there is no file on disk we own — so this prints the two
 * commands and claims nothing, which is the same never-dead-end contract the
 * installer applies to a harness it cannot drive.
 *
 * Every path is EXACT — the precise file or directory the plugin installer
 * writes. Nothing here is a glob, and nothing walks a tree looking for matches.
 */
export function planPluginRemoval({ home, env = {}, exists = () => false, lastDaemon = true } = {}) {
  const hermesDir = env.HERMES_DIR || join(home, '.hermes');
  const codexDir = env.CODEX_DIR || join(home, '.codex');
  const skillsDir = env.SKILLS_DIR || join(home, '.agents', 'skills');

  const manual = {
    key: 'claude-code',
    label: 'Claude Code plugin',
    action: 'manual',
    reason: "its plugin lives in Claude Code's in-app marketplace, so nothing on disk is ours to remove",
    steps: ['/plugin uninstall ours', '/plugin marketplace remove adapt-toolkit/ours-claude-marketplace'],
  };
  if (!lastDaemon) {
    return {
      action: 'keep',
      reason: 'another daemon on this machine still uses these plugins',
      harnesses: [],
      manual: [manual],
      packages: [],
    };
  }

  const harnesses = [];
  const hermesConfig = join(hermesDir, 'config.yaml');
  if (exists(hermesConfig) || exists(hermesDir)) {
    harnesses.push({
      key: 'hermes',
      label: 'Hermes plugin',
      blocks: [{ path: hermesConfig, markers: YAML_BLOCK }],
      dirs: [
        join(hermesDir, 'skills', 'communication', 'ours'),
        join(hermesDir, 'skills', 'communication', 'writing-agent-bios'),
      ],
      files: [join(hermesDir, 'ours-connector.env'), join(hermesDir, 'ours-connector.log')],
      pkg: '@ours.network/hermes',
    });
  }
  if (exists(join(codexDir, 'config.toml')) || exists(codexDir)) {
    harnesses.push({
      key: 'codex',
      label: 'Codex plugin',
      blocks: [
        { path: join(codexDir, 'config.toml'), markers: YAML_BLOCK },
        { path: join(codexDir, 'AGENTS.md'), markers: MD_BLOCK },
      ],
      dirs: [join(skillsDir, 'ours'), join(skillsDir, 'writing-agent-bios')],
      files: [],
      pkg: '@ours.network/codex',
    });
  }
  return {
    action: 'remove',
    harnesses,
    manual: [manual],
    packages: harnesses.map((h) => h.pkg),
  };
}

/**
 * The whole §8 order, refusing at step 1 rather than starting and stopping
 * half-way.
 */
export function planUninstall({ home, env = {}, endpoint, stateDir, purge = false, assumeYes = false, confirmedComponents = [], readJson, exists = () => true, cliStartedIt = true, otherStateDirsWithConfig = [], typedConfirmation = null }) {
  const dir = resolve(stateDir);
  const lastDaemon = otherStateDirsWithConfig.map((d) => resolve(d)).filter((d) => d !== dir).length === 0;
  const plugins = planPluginRemoval({ home, env, exists, lastDaemon });
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
    state: planStatePurge({ stateDir: dir, purge, assumeYes, exists, typedConfirmation }),
    plugins,
    packages: planGlobalPackages({ stateDir: dir, otherStateDirsWithConfig, pluginPackages: plugins.packages }),
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
