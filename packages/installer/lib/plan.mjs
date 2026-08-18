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
 * THE legacy/foreign SPLIT IS NOW THE ENTIRE SAFETY BOUNDARY. A `legacy` unit is
 * rewritten SILENTLY — no prompt stands between this match and someone's file —
 * so this match must stay a POSITIVE IDENTIFICATION of ours-mcp's own unit and
 * must never drift toward "probably ours". A later reader must not collapse the
 * two into one "unmarked unit" case for tidiness, and must not relax the patterns
 * to catch more variants.
 *
 * For `foreign` we do not know what the file is, so the installer stops, offers
 * no command, and does not prompt either: a confirmation dialogue over an
 * unidentified file in someone's systemd directory is how you talk a user into
 * destroying something.
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
 *   { action: 'adopt', notice, … }               — a legacy ours-mcp unit is in the
 *                                                  way; rewrite it, and print one
 *                                                  informational line naming it
 *   { action: 'refuse', exitCode: 2, … }         — unknown unit, or unusable state dir
 *
 * Adoption of a legacy unit is SILENT: no prompt, no question, so an upgrading
 * user has no manual step. The one line of output exists so the replacement is not
 * literally invisible; it does not block and it is not a warning.
 *
 * BECAUSE THERE IS NO PROMPT, `classifyUnit`'s `legacy` match is now the ENTIRE
 * safety boundary between a stranger's file and a silent rewrite. It must stay
 * strict — a positive identification of ours-mcp's own unit, never "probably
 * ours". A `foreign` unit is still a hard stop with no command and no prompt.
 *
 * `adopt` still carries no command: the --force comes from
 * serviceInstallCommand({ adoptLegacyUnit: true }), which the orchestrator opts
 * into explicitly. The boundary is worth keeping in the shape of the API even
 * without a question in front of it — it is what keeps --force from becoming a
 * default that spreads to the other cases.
 */
export function planServiceInstall({ stateDir, home, readText, platform = 'linux' }) {
  // THE BOOT SERVICE IS LINUX-ONLY, AND NOT BECAUSE THIS FILE SAYS SO.
  //
  // `ours daemon install-service` in @ours.network/cli builds its adapter with
  // `createLinuxUserSystemdAdapter()` and no platform branch at all, and that
  // factory's FIRST line is
  //   if (deps.platform !== 'linux') throw new Error('service management is not
  //   supported on <platform>; use an external launcher for `ours daemon serve`')
  // — verified by reading the published 0.4.1 tarball, which contains zero
  // occurrences of launchd, LaunchAgents or plist.
  //
  // So calling it on macOS does not degrade, it THROWS. Before this, a Mac user
  // was told their platform was supported, watched the CLI install, the config
  // write and the daemon start, and then got an exception and a rolled-back
  // config. Skipping the step leaves them a working daemon and one true sentence
  // instead — which is the whole of this change.
  //
  // A real launchd adapter belongs in the SDK CLI, not here. Nothing in this
  // package can install a launchd agent, and pretending otherwise by writing a
  // plist ourselves would put a second service implementation in a second repo.
  // THE macOS SKIP IS GONE, AND THAT IS A CONSEQUENCE OF THE DAEMON CHANGE.
  //
  // It existed because `ours daemon install-service` refuses on any non-linux
  // platform — createLinuxUserSystemdAdapter() throws on its first line, and the
  // whole @ours.network/cli package contains no launchd support. That was true and
  // is no longer the relevant question: the unit is now installed by ours-mcp's
  // own install-service, which handles systemd AND launchd
  // (packages/core/src/cli.ts writes ~/Library/LaunchAgents and runs launchctl
  // bootstrap). So macOS gets a real boot service rather than a named gap.
  //
  // A gap list that warns about something already fixed is as misleading as one
  // that hides something broken, which is why the warning goes with the skip.
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
  // wrote. It is adopted and rewritten SILENTLY — no prompt, no question — so an
  // upgrading user has no manual step at all. Safe because nothing under the
  // state directory changes when a unit file is replaced: identities, keys,
  // contacts and message history are untouched, which the 0.16.0 -> ours-sdk
  // migration run established rather than assumed.
  //
  // There is no assumeYes parameter any more, and that is the point: with no
  // consent to withhold, an unattended run must behave EXACTLY like an
  // interactive one. A dead flag here would be an invitation to reintroduce a
  // difference between the two.
  return {
    action: 'adopt',
    unit: derived.unit,
    unitPath: derived.path,
    instance: derived.instance,
    stateDir: resolve(stateDir),
    notice: legacyReplacedNotice(derived.path, resolve(stateDir)),
  };
}

/**
 * The single informational line printed when a legacy unit is replaced.
 *
 * Not a warning and not a question — it exists so the replacement is not
 * literally invisible. It names the exact file, and says the state directory is
 * untouched.
 *
 * That second clause is accuracy, not reassurance: replacing a systemd unit does
 * not change a byte under the state directory. DO NOT "improve" this line by
 * adding a data-loss warning. It would be false, and it would push people into
 * reinstalling — the one action that really would cost them their identities. A
 * test asserts this text contains no lost/delete/erase/wipe/destroy wording, and
 * that assertion is here to stop exactly that edit.
 */
export function legacyReplacedNotice(unitPath, stateDir) {
  return `replaced ${unitPath} — the boot unit an older ours-mcp installed (your state directory ${stateDir} is untouched)`;
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
  // --json so the caller can read back whether the unit actually CHANGED. The
  // CLI owns that byte-comparison, and an installer that guessed at it would
  // report "nothing changed" on a run that rewrote a unit.
  // ours-mcp's install-service, NOT the SDK CLI's, and the difference is not
  // cosmetic. `ours daemon install-service` writes a unit whose ExecStart runs
  // `ours daemon serve` — a daemon that does not mount /mcp — so the boot service
  // would resurrect exactly the daemon the /mcp 404 came from. ours-mcp's writes
  // ExecStart=<node> <ours-mcp> serve (packages/core/src/service-instance.ts:106),
  // and it handles launchd as well as systemd.
  //
  // It takes no arguments: like `start`, it is selected by OURS_CONFIG /
  // OURS_PORT / OURS_STATE_DIR, and it BAKES those resolved values into the unit.
  // The caller passes the pair as an environment, which is why this returns a bare
  // command and the orchestrator supplies daemonEnv.
  //
  // WHAT IS LOST, stated rather than discovered later. ours-mcp's install-service
  // takes NO flags:
  //
  //   · no --json, so the caller cannot read back whether the unit actually
  //     changed. `changed` is now assumed true, which is the safe direction for a
  //     summary line but is an assumption where it used to be an answer.
  //   · no --force, and no marker check either: it writes the unit file
  //     unconditionally. The SDK CLI refused to overwrite a unit it had not
  //     marked, and that refusal was the backstop behind classifyUnit. It is gone.
  //     classifyUnit's `foreign` refusal is now the ONLY thing standing between a
  //     stranger's unit file and an overwrite, so `adoptLegacyUnit` no longer
  //     changes the COMMAND — it records that the caller already decided, and the
  //     decision is enforced entirely by refusing to get here at all.
  //
  // That is a real reduction in defence in depth and it belongs in the PR, not in
  // a comment nobody reads.
  return ['ours-mcp', 'install-service'];
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
