// ours-install v3 — argument handling and daemon detection.
//
// Spec: installer-spec-v3 §§1-3. Everything here is PURE: the orchestrator
// injects the probe, the file reads and the port check, so the whole decision
// table is testable without a socket, a daemon or a filesystem.
//
// THE ONE IDEA. A daemon is identified by its STATE DIRECTORY, not by its port.
// `--state-dir` is the key; `--port` is derived from whatever daemon already
// owns that directory, and is only searched when this run creates one. Every
// function below follows from that.

import { resolve, join } from 'node:path';
import { homedir } from 'node:os';

export const DEFAULT_STATE_DIR_NAME = '.ours';
export const INSTALL_DEFAULT_PORT = 3050;
export const FREE_PORT_FLOOR = 3050;

// Ports that are other components' DEFAULTS, not facts about the machine: 3051
// is the Telegram connector's, 3052 is cowork's loopback console. The free-port
// search skips them; an explicit --port is still honoured as typed (spec §2).
//
// NOTE, deliberately not silently reconciled: lib/logic.mjs's RESERVED_PORTS is
// [3051] on this branch, while spec §2 states [3051, 3052] citing the
// dev4/version-plumbing branch. This constant follows the spec. The two should
// be merged once someone decides whether cowork's 3052 belongs in the shipped
// list — flagged rather than assumed.
export const INSTALL_RESERVED_PORTS = [3051, 3052];

// The CLI-owned PID record that proves a daemon belongs to a state directory
// even when nothing is recorded in its config (spec §1).
export const CLI_PID_RECORD = 'ours-cli-daemon.json';
export const DAEMON_CONFIG = 'config.json';

export class InstallUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InstallUsageError';
    this.exitCode = 2;
  }
}

// Lexical path comparison, matching how the SDK compares a reported state
// directory against a selected one. Resolving symlinks would mean touching the
// filesystem before validation, which is what this comparison exists to avoid.
export function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  return resolve(a) === resolve(b);
}

// -----------------------------------------------------------------------------
// §2 — arguments
// -----------------------------------------------------------------------------

const VALUE_FLAGS = new Set(['--state-dir', '--port']);
const BOOLEAN_FLAGS = new Set(['--dry-run', '--help', '--version']);
const ALIASES = new Map([['-h', '--help'], ['-V', '--version']]);

/**
 * `ours-install [--state-dir PATH] [--port N] [--dry-run] [--help] [--version]`
 *
 * Returns the run's target with both values already resolved, so the opening
 * screen can echo exactly what the run will act on. An unknown flag, a missing
 * value or an out-of-range port is an InstallUsageError (exit 2) — the installer
 * never guesses what an operator meant.
 *
 * `port` is null when not given. That is meaningful: "not given" lets the port be
 * derived from an existing daemon, whereas an explicit value must be honoured or
 * refused, never quietly moved.
 */
export function parseInstallArgs(argv = [], env = {}, { home = homedir() } = {}) {
  const out = {
    stateDir: null,
    port: null,
    portExplicit: false,
    dryRun: env.OURS_INSTALL_DRY_RUN === '1',
    assumeYes: env.OURS_ASSUME_YES === '1',
    help: false,
    version: false,
  };
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const raw = String(argv[i]);
    const equal = raw.indexOf('=');
    const name = ALIASES.get(equal < 0 ? raw : raw.slice(0, equal)) ?? (equal < 0 ? raw : raw.slice(0, equal));
    if (BOOLEAN_FLAGS.has(name)) {
      if (equal >= 0) throw new InstallUsageError(`${name} does not take a value`);
      if (seen.has(name)) throw new InstallUsageError(`${name} may be given only once`);
      seen.add(name);
      if (name === '--dry-run') out.dryRun = true;
      if (name === '--help') out.help = true;
      if (name === '--version') out.version = true;
      continue;
    }
    if (!VALUE_FLAGS.has(name)) throw new InstallUsageError(`unknown option: ${name}`);
    if (seen.has(name)) throw new InstallUsageError(`${name} may be given only once`);
    seen.add(name);
    const value = equal >= 0 ? raw.slice(equal + 1) : argv[++i];
    if (value === undefined || value === '') throw new InstallUsageError(`${name} requires a value`);
    if (name === '--state-dir') out.stateDir = resolve(String(value));
    if (name === '--port') {
      if (!/^[0-9]+$/.test(String(value).trim())) throw new InstallUsageError('--port must be an integer');
      const n = Number.parseInt(String(value).trim(), 10);
      if (!Number.isInteger(n) || n < 1 || n > 65535) throw new InstallUsageError('--port must be between 1 and 65535');
      out.port = n;
      out.portExplicit = true;
    }
  }
  if (out.stateDir === null) out.stateDir = resolve(join(home, DEFAULT_STATE_DIR_NAME));
  return out;
}

// -----------------------------------------------------------------------------
// §§1, 3 — is there a daemon at this state directory?
// -----------------------------------------------------------------------------

/**
 * The port to probe first: the one recorded in <state-dir>/config.json, else the
 * built-in default. An explicit --port does NOT change where we look — the
 * question is which daemon owns this directory, and that is answered by the
 * directory's own record, not by what the operator typed (spec §2 step 2).
 */
export function candidatePort(config) {
  const recorded = config && typeof config.port === 'number' && Number.isFinite(config.port) ? config.port : null;
  return recorded ?? INSTALL_DEFAULT_PORT;
}

/**
 * Classify one probe result against the target state directory (spec §3).
 *
 *   present — an ours daemon answered and reports THIS state directory
 *   foreign — something answered, but it is not an ours daemon, or it is one
 *             owning a different state directory
 *   absent  — nothing answered
 *
 * `probe` is `{ ok: true, stateDir }` for a daemon that answered `/state-dir`,
 * or `{ ok: false, reason }` for no answer / non-JSON / HTTP error.
 */
export function classifyProbe(probe, targetStateDir) {
  if (!probe || probe.ok !== true) return { kind: 'absent', reason: probe?.reason ?? 'no answer' };
  if (typeof probe.stateDir !== 'string' || !probe.stateDir) {
    return { kind: 'foreign', reason: 'answered but did not report a state directory' };
  }
  if (!samePath(probe.stateDir, targetStateDir)) {
    return { kind: 'foreign', reason: 'daemon owns a different state directory', stateDir: resolve(probe.stateDir) };
  }
  return { kind: 'present', stateDir: resolve(probe.stateDir) };
}

/**
 * Find the daemon that owns this state directory, if any.
 *
 * Two lookups, in order, and the second is the one the spec did not have:
 *
 * 1. The port recorded in <state-dir>/config.json (else the default).
 * 2. **The port in <state-dir>/ours-cli-daemon.json.** A daemon started by hand
 *    with OURS_PORT=3060 and never installed records nothing in config.json, so
 *    lookup 1 misses it and the caller would conclude "no daemon here" and create
 *    a SECOND daemon on the SAME state directory. There is no cross-process lock
 *    on a state directory, and two writers on one state_data.bin is a corruption
 *    case. So any daemon reporting this state directory on ANY port we can learn
 *    about counts as present.
 *
 * A PID record whose port does not answer is STALE, not present — reported as
 * such so the caller can say why it is creating a daemon.
 *
 * Injected IO: `probe(port)`, `readJson(path)`.
 */
export function findDaemon({ stateDir, probe, readJson }) {
  const target = resolve(stateDir);
  const config = readJson(join(target, DAEMON_CONFIG));
  const first = candidatePort(config);
  const byConfig = classifyProbe(probe(first), target);
  if (byConfig.kind !== 'absent') return { ...byConfig, port: first, via: 'config', config };

  const record = readJson(join(target, CLI_PID_RECORD));
  const recorded = record && typeof record.port === 'number' && Number.isFinite(record.port) ? record.port : null;
  if (recorded !== null && recorded !== first) {
    const byRecord = classifyProbe(probe(recorded), target);
    if (byRecord.kind === 'present') return { ...byRecord, port: recorded, via: 'pid-record', config };
    // A foreign daemon on the PID record's port says nothing about OUR daemon —
    // the record is simply stale. Do not refuse the run over it.
    return { kind: 'absent', reason: 'stale PID record', stalePidRecord: recorded, port: first, via: 'config', config };
  }
  return { kind: 'absent', reason: byConfig.reason, port: first, via: 'config', config };
}

// -----------------------------------------------------------------------------
// §2 — the derived-port rule
// -----------------------------------------------------------------------------

/**
 * Decide what this run does about the daemon at `stateDir`. One of:
 *
 *   { action: 'update', port }   — a daemon already owns this directory
 *   { action: 'create', port }   — none does; this run creates one
 *   { action: 'refuse', exitCode: 2, reason, … } — write nothing
 *
 * Refusals, both following the SDK's precedent of refusing an incoherent
 * selection rather than silently correcting it:
 *
 *   - an explicit `--port` that disagrees with the port the existing daemon is
 *     actually on. Ignoring it would leave the operator believing they addressed
 *     the daemon on the port they typed while the run touched a different one.
 *   - something answering the candidate port that is not this directory's daemon.
 *
 * When creating: an explicit `--port` is used exactly as given and NEVER moved —
 * if it is occupied that is a refusal, not a reason to shift. Only a derived port
 * is searched, from 3050 upward, skipping the reserved defaults.
 */
export function resolveTarget({ stateDir, port = null, portExplicit = false, probe, readJson, isTaken }) {
  const target = resolve(stateDir);
  const found = findDaemon({ stateDir: target, probe, readJson });

  if (found.kind === 'foreign') {
    return {
      action: 'refuse',
      exitCode: 2,
      reason: 'foreign-daemon',
      port: found.port,
      stateDir: target,
      otherStateDir: found.stateDir ?? null,
      message: found.stateDir
        ? `port ${found.port} answers, but that daemon owns state directory ${found.stateDir}, not ${target}`
        : `port ${found.port} answers, but it is not an ours daemon`,
    };
  }

  if (found.kind === 'present') {
    if (portExplicit && port !== found.port) {
      return {
        action: 'refuse',
        exitCode: 2,
        reason: 'port-mismatch',
        port: found.port,
        stateDir: target,
        message: `--port ${port} disagrees with port ${found.port}, where the daemon for ${target} is actually running`,
      };
    }
    return { action: 'update', port: found.port, stateDir: target, config: found.config };
  }

  // Creating. Only now is a port chosen.
  if (portExplicit) {
    if (isTaken(port)) {
      return {
        action: 'refuse',
        exitCode: 2,
        reason: 'port-occupied',
        port,
        stateDir: target,
        message: `port ${port} is already in use, and an explicit --port is never moved`,
      };
    }
    return {
      action: 'create',
      port,
      stateDir: target,
      stalePidRecord: found.stalePidRecord ?? null,
      // Purely informational: honoured as typed, but the operator should see it.
      reservedNotice: INSTALL_RESERVED_PORTS.includes(port) ? port : null,
    };
  }
  return {
    action: 'create',
    port: searchFreePort(isTaken),
    stateDir: target,
    stalePidRecord: found.stalePidRecord ?? null,
    reservedNotice: null,
  };
}

/**
 * First free port from 3050 upward, skipping other components' defaults. Returns
 * null when the band is exhausted rather than looping or reusing a bound port —
 * the caller reports it.
 */
export function searchFreePort(isTaken, { floor = FREE_PORT_FLOOR, reserved = INSTALL_RESERVED_PORTS, span = 1000 } = {}) {
  for (let p = floor; p < floor + span; p += 1) {
    if (reserved.includes(p)) continue;
    if (!isTaken(p)) return p;
  }
  return null;
}
