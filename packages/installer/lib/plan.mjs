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
 * The legacy/foreign split is the whole point. For `legacy` we know exactly what
 * the file is and can name the one command that clears it. For `foreign` we do
 * NOT know what it is, so the installer stops and says so — it must never offer
 * to remove a file it cannot identify, and must never pass --force on the user's
 * behalf in either case. The guard exists for a reason; bypassing it invisibly is
 * how the next silent clobber ships.
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
 *   { action: 'install' }                       — call the CLI; it does the rest
 *   { action: 'migrate-unit', command, unit }    — legacy ours-mcp unit in the way
 *   { action: 'refuse', exitCode: 2, … }         — unknown unit, or unusable state dir
 *
 * `migrate-unit` is deliberately NOT an automatic --force. The caller shows the
 * user what is there and what will happen, and either runs the named command with
 * their consent or stops. Non-interactively it is a refusal, because
 * OURS_ASSUME_YES suppresses questions and never suppresses a refusal (spec §9).
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
  const plan = {
    action: 'migrate-unit',
    unit: derived.unit,
    unitPath: derived.path,
    instance: derived.instance,
    command: ['ours-mcp', 'uninstall-service'],
    message: `${derived.path} is the boot service written by an older ours-mcp. It has to be removed before the new one can be installed; \`ours daemon install-service\` will not overwrite a unit it does not manage.`,
  };
  if (assumeYes) {
    return {
      ...plan,
      action: 'refuse',
      exitCode: 2,
      reason: 'legacy-unit-needs-consent',
      message: `${plan.message} Run \`ours-mcp uninstall-service\` and re-run the installer. This is not done automatically in non-interactive mode.`,
    };
  }
  return plan;
}

/**
 * The CLI invocation that installs the boot service. The unit NAME is not passed:
 * ours-sdk #20 made the CLI derive it from --state-dir itself, which is why spec
 * §4's "the installer must either pass a per-instance unit name or write the unit
 * itself" no longer applies — neither, it selects the daemon and the CLI names
 * the unit. One derivation, in one place.
 */
export function serviceInstallCommand({ stateDir }) {
  const dir = resolve(stateDir);
  return ['ours', 'daemon', 'install-service', '--yes', '--state-dir', dir, '--config', join(dir, 'config.json')];
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
