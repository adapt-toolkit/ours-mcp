// ours-install v3 — daemon creation and boot-service installation.
//
// Spec: installer-spec-v3 §§3-4. Pure, like lib/target.mjs: the orchestrator
// injects file reads, and every function returns a PLAN the caller renders and
// executes. Nothing here writes, spawns, or runs systemctl.

import { join, resolve, basename } from 'node:path';

export const CLI_UNIT_MARKER = '# Managed by @ours.network/cli';
export const SYSTEMD_USER_DIR = ['.config', 'systemd', 'user'];
export const DEFAULT_SYSTEMD_UNIT = 'ours.service';

// -----------------------------------------------------------------------------
// §4 — which unit file does this state directory own?
// -----------------------------------------------------------------------------

// 1–32 chars, alphanumeric with interior hyphens/underscores, no dots.
const INSTANCE_RE = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,30}[A-Za-z0-9])?$/;

/**
 * State directory -> systemd user unit name.
 *
 * SOURCE OF TRUTH IS ours-sdk `packages/cli/src/service-instance.ts` (merged in
 * ours-sdk #20). The CLI performs this derivation itself when it installs, so
 * the installer does NOT pass a unit name — it only needs to know which file to
 * INSPECT before invoking the CLI, because of the unmarked-unit case below.
 * This is a deliberate second copy across two repos; the table test pins it, and
 * if the CLI's rule ever changes this must change with it.
 *
 * `~/.ours` -> '' -> ours.service (the historical unnamed unit, unchanged).
 */
export function unitNameForStateDir(stateDir) {
  const segment = basename(resolve(stateDir));
  const undotted = segment.startsWith('.') ? segment.slice(1) : segment;
  if (undotted === 'ours') return { ok: true, unit: DEFAULT_SYSTEMD_UNIT, instance: '' };
  const name = undotted.startsWith('ours-') ? undotted.slice('ours-'.length) : undotted;
  if (!name || name.length > 32 || !INSTANCE_RE.test(name)) {
    return { ok: false, unit: null, instance: null, reason: `state directory ${resolve(stateDir)} does not yield a usable service name (${JSON.stringify(name)})` };
  }
  return { ok: true, unit: `ours-${name}.service`, instance: name };
}

export function unitPathForStateDir(stateDir, home) {
  const derived = unitNameForStateDir(stateDir);
  if (!derived.ok) return derived;
  return { ...derived, path: join(home, ...SYSTEMD_USER_DIR, derived.unit) };
}

// -----------------------------------------------------------------------------
// The unmarked-unit case — the migration blocker
// -----------------------------------------------------------------------------

/**
 * Classify whatever is already at the unit path.
 *
 *   absent      — nothing there; install proceeds
 *   cli-managed — written by @ours.network/cli; the CLI's own idempotence and
 *                 its baked-state-dir guard handle it from here
 *   legacy      — the unit published ours-mcp wrote: NO marker, ExecStart running
 *                 ours-mcp. This is the migration blocker. `ours daemon
 *                 install-service` refuses to overwrite an unmarked unit without
 *                 --force, so spec §4 step 4 fails for every existing Linux user.
 *   foreign     — unmarked and NOT recognisably ours-mcp's. Someone else's file.
 *
 * The legacy/foreign split is the whole point, and a later reader must not
 * collapse the two into one "unmarked unit" case for tidiness. For `legacy` we
 * know exactly what the file is, so the installer may offer to replace it — after
 * showing the path and getting a yes. For `foreign` we do NOT know what it is, so
 * the installer stops, offers no command, and does not even prompt: a
 * confirmation dialogue over an unidentified file in someone's systemd directory
 * is how you talk a user into destroying something. Neither case ever passes
 * --force without an answer.
 */
export function classifyUnit(text) {
  if (text === null || text === undefined) return { kind: 'absent' };
  const s = String(text);
  if (s.startsWith(CLI_UNIT_MARKER)) return { kind: 'cli-managed' };
  const looksLikeOursMcp = /ExecStart=.*\bours-mcp\b/.test(s)
    || /^Description=ours MCP daemon\b/m.test(s)
    || (/^Environment=OURS_STATE_DIR=/m.test(s) && /^Environment=OURS_TRANSPORT=http$/m.test(s));
  return looksLikeOursMcp ? { kind: 'legacy' } : { kind: 'foreign' };
}

/**
 * What this run should do about the boot service (spec §4 step 4).
 *
 * Returns one of:
 *   { action: 'install' }                        — call the CLI; it does the rest
 *   { action: 'confirm-replace', prompt, … }     — a legacy ours-mcp unit is in the
 *                                                  way and may be adopted, but only
 *                                                  after the user says yes to the
 *                                                  exact file path being replaced
 *   { action: 'refuse', exitCode: 2, … }         — unknown unit, unusable state dir,
 *                                                  or a legacy unit under assume-yes
 *
 * NOTHING here silently replaces anything. `confirm-replace` carries no command:
 * the --force that adopts a legacy unit comes from
 * serviceInstallCommand({ adoptLegacyUnit: true }), which the orchestrator calls
 * only after the answer. A `foreign` unit gets no prompt at all — a confirmation
 * dialogue over a file we cannot identify is just a way to talk someone into
 * overwriting it.
 */
export function planServiceInstall({ stateDir, home, readText, assumeYes = false }) {
  const derived = unitPathForStateDir(stateDir, home);
  if (!derived.ok) {
    return { action: 'refuse', exitCode: 2, reason: 'unusable-state-dir', message: derived.reason };
  }
  const existing = classifyUnit(readText(derived.path));
  if (existing.kind === 'absent' || existing.kind === 'cli-managed') {
    return { action: 'install', unit: derived.unit, unitPath: derived.path, instance: derived.instance };
  }
  if (existing.kind === 'foreign') {
    return {
      action: 'refuse',
      exitCode: 2,
      reason: 'unknown-unit',
      unit: derived.unit,
      unitPath: derived.path,
      message: `${derived.path} already exists and was not written by ours. Refusing to touch it. Inspect it, and remove it yourself if it is no longer wanted.`,
    };
  }
  // The legacy case: a unit we POSITIVELY identify as the one published ours-mcp
  // wrote. The installer may adopt and rewrite it itself, so an ordinary user is
  // not sent away to run a command — but only behind an explicit yes, and only
  // after being shown the exact file it would replace. There is no silent
  // replacement, in either direction.
  const plan = {
    action: 'confirm-replace',
    unit: derived.unit,
    unitPath: derived.path,
    instance: derived.instance,
    stateDir: resolve(stateDir),
    prompt: legacyReplacePrompt(derived.path, resolve(stateDir)),
    // Deliberately NOT the command itself. The --force that adopts this unit is
    // produced by serviceInstallCommand({ adoptLegacyUnit: true }) and exists
    // nowhere in this plan, so no caller can reach it without passing through the
    // confirmation above. The "no --force in any plan" test pins that boundary.
    message: `${derived.path} is the boot service an older ours-mcp installed. Replacing it is what completes the upgrade.`,
  };
  if (assumeYes) {
    // OURS_ASSUME_YES suppresses questions; it never suppresses a refusal, and an
    // unattended run must not take a confirmation it never received (spec §9).
    return {
      action: 'refuse',
      exitCode: 2,
      reason: 'legacy-unit-needs-consent',
      unit: derived.unit,
      unitPath: derived.path,
      message: `${derived.path} is the boot service an older ours-mcp installed. Replacing it needs an explicit confirmation, which a non-interactive run cannot give. Re-run interactively, or remove it yourself with \`ours-mcp uninstall-service\`.`,
    };
  }
  return plan;
}

/**
 * The confirmation text for adopting a legacy unit.
 *
 * It names the exact FILE being replaced, and it says plainly that the state
 * directory and keys are untouched. That second half is not reassurance, it is
 * accuracy: replacing a systemd unit does not touch a single byte under the
 * state directory, and a "your data may be lost" warning here would be FALSE and
 * would push people into reinstalling — which is the one outcome that really
 * would cost them their identities.
 */
export function legacyReplacePrompt(unitPath, stateDir) {
  return [
    `${unitPath} was installed by an older ours-mcp and has to be replaced with the new one.`,
    `Only that unit file changes. Your state directory ${stateDir} is not touched — identities, keys, contacts and message history all stay exactly as they are.`,
    'Replace it?',
  ].join('\n');
}

/**
 * The CLI invocation that installs the boot service. The unit NAME is not passed:
 * ours-sdk #20 made the CLI derive it from --state-dir itself, which is why spec
 * §4's "the installer must either pass a per-instance unit name or write the unit
 * itself" no longer applies — neither, it selects the daemon and the CLI names
 * the unit. One derivation, in one place.
 */
export function serviceInstallCommand({ stateDir, adoptLegacyUnit = false }) {
  const dir = resolve(stateDir);
  const cmd = ['ours', 'daemon', 'install-service', '--yes', '--state-dir', dir, '--config', join(dir, 'config.json')];
  // --force is reachable ONLY through this explicit argument, which the
  // orchestrator passes only after the user answered yes to legacyReplacePrompt.
  // It is never a default and never appears in a plan.
  if (adoptLegacyUnit) cmd.push('--force');
  return cmd;
}

// -----------------------------------------------------------------------------
// §3(a) step 2 / §4 step 2 — the daemon config file
// -----------------------------------------------------------------------------

/**
 * Merge, never rewrite: only `port`, `stateDir` and `brokerUrl` are set, every
 * other key in the file is preserved, and a merge that would change nothing
 * reports `changed: false` so the caller can leave the file untouched.
 *
 * `stateDir` is written absolute and always alongside `port`, so the pair that
 * identifies a daemon never travels half-formed.
 */
export function planDaemonConfig(existing, { port, stateDir, brokerUrl }) {
  const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
  const patch = { port, stateDir: resolve(stateDir), brokerUrl };
  const merged = { ...base };
  const changes = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null) continue;
    if (merged[key] === value) continue;
    changes.push(key);
    merged[key] = value;
  }
  return { changed: changes.length > 0, changes, config: merged, text: `${JSON.stringify(merged, null, 2)}\n` };
}

/**
 * The ordered, announced steps for the daemon half of a run (spec §4). Each is
 * idempotent, and an `update` skips creation entirely: it never moves a port and
 * never creates a second daemon.
 */
export function planDaemonSteps(target, { cliVersionChanged = false, cliStartedIt = true } = {}) {
  const dir = target.stateDir;
  const steps = [{ id: 'cli', label: 'install the ours-sdk CLI', command: ['npm', 'i', '-g', '@ours.network/cli'] }];
  steps.push({ id: 'config', label: `write ${join(dir, 'config.json')}`, port: target.port });
  if (target.action === 'create') {
    steps.push({ id: 'start', label: `start the daemon on port ${target.port}`, command: ['ours', 'daemon', 'start', '--config', join(dir, 'config.json')] });
  } else if (cliVersionChanged) {
    // `ours daemon stop` refuses to signal a daemon it did not start, so a
    // daemon under another launcher is left running and the caller says which
    // launcher must be restarted instead.
    steps.push(cliStartedIt
      ? { id: 'restart', label: 'restart the daemon (package version changed)', command: ['ours', 'daemon', 'restart', '--config', join(dir, 'config.json')] }
      : { id: 'restart-external', label: 'daemon was not started by the CLI — restart it with its own launcher', command: null });
  }
  steps.push({ id: 'service', label: 'install the boot service', command: serviceInstallCommand({ stateDir: dir }) });
  return steps;
}
