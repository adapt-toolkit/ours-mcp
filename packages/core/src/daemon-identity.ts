// Daemon identity, state-directory exclusivity, and collision diagnostics.
//
// Everything here answers one question: "is the daemon I am about to start — or
// the one already answering on this port — the daemon I actually meant?"
//
// Today the daemon is a host-wide singleton: one port, one state dir, resolved
// by config.ts as env > config.json > default. Running a second one is possible
// (give it a different OURS_PORT *and* a different OURS_STATE_DIR) but nothing
// checked that you did both, so two daemons could quietly share a state dir and
// interleave writes to the same identity packets. This module makes that
// impossible and makes every failure mode say what to do about it.
//
// Three primitives:
//   1. INSTANCE LABEL   — a non-secret name for a daemon, reported over /info.
//   2. STATE FINGERPRINT— identifies the state DIRECTORY, not the path string,
//                         so two aliases of one directory compare equal.
//   3. STATE LOCK       — <stateDir>/daemon.lock, exclusively held while a
//                         daemon owns that directory.
//
// Deliberately NOT here: deriving a port or state dir from an instance name.
// That is the named-instance model (P2); this file only carries the label.

import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { connect } from 'node:net';
import { join, resolve } from 'node:path';

import { linuxProcHasExited } from './process-state';

export const LOCK_FILENAME = 'daemon.lock';

// The implicit instance every existing install already is. Nothing about
// `default` derives from this name — it is what a daemon reports when no
// OURS_INSTANCE was set, so diagnostics have a word for "the normal one".
export const DEFAULT_INSTANCE = 'default';

// Exit codes. Distinct from 1 (generic failure) so a supervisor can tell a
// collision from a crash without scraping text.
export const EXIT_PORT_COLLISION = 3;
export const EXIT_STATE_COLLISION = 4;

// Filename-safe and systemd-unit-safe (`ours@<name>.service`), which is what
// P2 will instantiate. Enforced now so a label that ships today cannot become
// illegal later.
export const INSTANCE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;

export function validateInstanceName(name: string): string | null {
  if (!name) return 'instance name must not be empty';
  if (!INSTANCE_NAME_RE.test(name)) {
    return (
      `invalid instance name ${JSON.stringify(name)} — use 1-32 chars matching ` +
      '[a-z0-9][a-z0-9._-]* (lower-case, filename- and systemd-safe)'
    );
  }
  return null;
}

export interface ResolvedInstance {
  name: string;
  source: 'env' | 'default';
}

// OURS_INSTANCE names this daemon for diagnostics ONLY. It does not select a
// port, a state dir, or a config file — those still come from config.ts. Naming
// a daemon is what makes "port 3061 is held by instance work" possible; wiring
// the name to a config bundle is P2. Throws on a malformed name rather than
// silently falling back, so a typo surfaces at startup instead of producing a
// daemon that answers to a name nobody asked for.
export function resolveInstance(env: NodeJS.ProcessEnv = process.env): ResolvedInstance {
  const raw = env.OURS_INSTANCE?.trim();
  if (!raw) return { name: DEFAULT_INSTANCE, source: 'default' };
  const problem = validateInstanceName(raw);
  if (problem) throw new Error(`OURS_INSTANCE: ${problem}`);
  return { name: raw, source: 'env' };
}

// Identify the state DIRECTORY rather than the string used to reach it. Two
// daemons started as `/home/u/.ours` and `/home/u/../u/.ours`, or through a
// symlink or bind mount, are sharing one directory and must compare equal —
// a plain path comparison says they are different and would let them corrupt
// each other. device+inode is exactly "same directory" as the kernel sees it.
//
// Hashed because it is served unauthenticated over /info: the fingerprint
// answers "are we the same?" without publishing filesystem internals. The
// state dir path is already disclosed there, so this adds no new disclosure.
//
// Total by construction: a directory that cannot be stat'ed (not created yet,
// unreadable) degrades to hashing the resolved path, which is still stable and
// still correct for the common non-aliased case.
export function stateFingerprint(stateDir: string): string {
  const abs = resolve(stateDir);
  let seed: string;
  try {
    const st = fs.statSync(fs.realpathSync(abs));
    seed = `dev:${st.dev}:ino:${st.ino}`;
  } catch {
    seed = `path:${abs}`;
  }
  return createHash('sha256').update(seed).digest('hex').slice(0, 16);
}

export function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0 = existence check
    // kill(pid, 0) also succeeds for a Linux zombie. A zombie has already
    // exited and released its files, so it does not own the state dir.
    if (process.platform === 'linux') {
      try {
        if (linuxProcHasExited(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'))) return false;
      } catch {
        try {
          process.kill(pid, 0);
        } catch {
          return false;
        }
      }
    }
    return true;
  } catch {
    return false;
  }
}

// ----- daemon identity over the wire ----------------------------------------

// What GET /info reports. Every field is non-secret: a name the operator chose,
// a port they already know, a path already exposed by /state-dir, and a hash.
export interface DaemonIdentity {
  name?: string;
  version?: string;
  compat?: string;
  protocol?: number;
  pid?: number;
  stateDir?: string;
  instance?: string;
  stateFingerprint?: string;
  port?: number;
  startedAt?: string;
}

export function portOpen(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((res) => {
    const sock = connect({ host: '127.0.0.1', port });
    const done = (ok: boolean) => {
      sock.destroy();
      res(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

// Ask whatever is on this port to identify itself. /info is unauthenticated by
// design precisely so collision diagnostics work without a token; /state-dir is
// the fallback for daemons that predate /info. null means "nothing usable
// answered" — which includes a non-ours service, so callers must not read null
// as "the port is free".
export async function probeDaemonInfo(port: number, timeoutMs = 2_000): Promise<DaemonIdentity | null> {
  for (const path of ['/info', '/state-dir']) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let resp: Response;
      try {
        resp = await fetch(`http://127.0.0.1:${port}${path}`, { signal: ctrl.signal });
      } finally {
        clearTimeout(timer);
      }
      if (!resp.ok) continue;
      const body = (await resp.json()) as DaemonIdentity;
      // /state-dir predates `name`; it is still an ours daemon if it reports a
      // stateDir and a version, so accept it and let the caller decide.
      if (body && typeof body === 'object' && (body.name === 'ours' || typeof body.stateDir === 'string')) {
        return body;
      }
    } catch {
      /* try the next path, then give up */
    }
  }
  return null;
}

export type PortOccupant =
  | { kind: 'free' }
  // Something is listening but it is not an ours daemon (or is too broken to say).
  | { kind: 'foreign' }
  | { kind: 'ours'; info: DaemonIdentity; sameState: boolean };

// Classify what owns a port relative to the state dir WE intend to use.
// `sameState` is the load-bearing bit: an ours daemon on our port that is
// running our state dir means "already running" (idempotent, fine); one on a
// DIFFERENT state dir means we would be talking to somebody else's daemon.
export async function inspectPort(port: number, expectedStateDir: string): Promise<PortOccupant> {
  if (!(await portOpen(port))) return { kind: 'free' };
  const info = await probeDaemonInfo(port);
  if (!info) return { kind: 'foreign' };
  return { kind: 'ours', info, sameState: sameStateDir(info, expectedStateDir) };
}

// Prefer the fingerprint (alias-proof) and fall back to a resolved-path compare
// for daemons too old to report one.
export function sameStateDir(info: DaemonIdentity, expectedStateDir: string): boolean {
  const expected = resolve(expectedStateDir);
  if (info.stateFingerprint) return info.stateFingerprint === stateFingerprint(expected);
  return typeof info.stateDir === 'string' && resolve(info.stateDir) === expected;
}

function describe(info: DaemonIdentity): string {
  const bits = [
    `instance "${info.instance ?? DEFAULT_INSTANCE}"`,
    info.stateDir ? `state ${info.stateDir}` : null,
    info.pid ? `pid ${info.pid}` : null,
    info.version ? `v${info.version}` : null,
  ].filter(Boolean);
  return bits.join(', ');
}

// The message a user gets when their daemon cannot have the port. It must name
// what is there and what to do next — the old behavior was an EADDRINUSE stack
// trace in daemon.log, which says neither.
export function formatPortCollision(port: number, stateDir: string, occupant: PortOccupant): string {
  if (occupant.kind === 'foreign') {
    return (
      `ours: port ${port} is held by a non-ours service.\n` +
      `      Pick another port:  OURS_PORT=<free-port> ours-mcp start\n` +
      `      Or find the holder: lsof -iTCP:${port} -sTCP:LISTEN`
    );
  }
  if (occupant.kind === 'ours' && occupant.sameState) {
    return `ours: this daemon is already running on port ${port} (${describe(occupant.info)}).`;
  }
  const info = occupant.kind === 'ours' ? occupant.info : {};
  return (
    `ours: port ${port} is already in use by another ours daemon (${describe(info)}).\n` +
    `      This daemon wants state ${resolve(stateDir)}, which is a DIFFERENT daemon —\n` +
    `      two daemons need a different port AND a different state dir:\n` +
    `        OURS_PORT=<free-port> OURS_STATE_DIR=<other-dir> ours-mcp start\n` +
    `      Or inspect what is there:  ours-mcp status --json`
  );
}

// ----- state-directory lock --------------------------------------------------

// The record written into <stateDir>/daemon.lock. It doubles as the answer to
// "what is running here?" for a CLI that has not (or cannot) reach the port.
export interface StateLockRecord {
  pid: number;
  port: number;
  instance: string;
  stateDir: string;
  stateFingerprint: string;
  version: string;
  startedAt: string;
}

export function stateLockPath(stateDir: string): string {
  return join(resolve(stateDir), LOCK_FILENAME);
}

export function readStateLock(stateDir: string): StateLockRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateLockPath(stateDir), 'utf8')) as StateLockRecord;
    return parsed && typeof parsed.pid === 'number' ? parsed : null;
  } catch {
    return null;
  }
}

export type StateLockResult =
  | { ok: true; record: StateLockRecord; release: () => void }
  // `holder` is null when the lock file existed but was unreadable/corrupt AND
  // could not be reclaimed — we refuse rather than guess.
  | { ok: false; holder: StateLockRecord | null };

// Take exclusive ownership of a state directory.
//
// O_EXCL create is the whole mechanism: it is atomic, so two daemons racing for
// the same directory cannot both win. A lock left behind by a crashed daemon is
// reclaimed once its pid is confirmed dead — a daemon that segfaults must not
// wedge its own state dir forever.
//
// A LIVE holder is always refused, even in the pathological case where the pid
// was recycled by an unrelated process. Refusing costs the user one command
// (`ours-mcp stop`, or deleting a lock the message names); guessing costs them
// two daemons interleaving writes into the same identity keys.
export function acquireStateLock(
  stateDir: string,
  meta: Omit<StateLockRecord, 'stateDir' | 'stateFingerprint' | 'startedAt'>,
): StateLockResult {
  const dir = resolve(stateDir);
  const path = stateLockPath(dir);
  fs.mkdirSync(dir, { recursive: true });
  const record: StateLockRecord = {
    ...meta,
    stateDir: dir,
    stateFingerprint: stateFingerprint(dir),
    startedAt: new Date().toISOString(),
  };

  // Two attempts: the second exists only to re-race after reclaiming a stale
  // lock. If we lose that race, another daemon legitimately owns the dir.
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number;
    try {
      fd = fs.openSync(path, 'wx', 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const holder = readStateLock(dir);
      if (holder && pidAlive(holder.pid)) return { ok: false, holder };
      if (attempt > 0) return { ok: false, holder };
      // Stale (dead pid) or corrupt (no pid to check) — reclaim and retry once.
      try {
        fs.rmSync(path, { force: true });
      } catch {
        return { ok: false, holder };
      }
      continue;
    }
    try {
      fs.writeSync(fd, JSON.stringify(record, null, 2) + '\n');
    } finally {
      fs.closeSync(fd);
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      // Only ever remove OUR lock. If a reclaim race left someone else's record
      // here, deleting it would hand our state dir to a third daemon.
      const current = readStateLock(dir);
      if (current && current.pid !== record.pid) return;
      try {
        fs.rmSync(path, { force: true });
      } catch {
        /* best effort — a stale lock is reclaimed by pid check on next start */
      }
    };
    return { ok: true, record, release };
  }
  return { ok: false, holder: readStateLock(dir) };
}

// Why a second daemon may not have this state directory. Sharing writable state
// is not a degraded mode that mostly works — concurrent writers interleave into
// the same identity packets and key material — so the message offers a separate
// state dir, never a way to share one.
export function formatStateCollision(stateDir: string, holder: StateLockRecord | null): string {
  const who = holder
    ? `instance "${holder.instance}" (pid ${holder.pid}, port ${holder.port}, started ${holder.startedAt})`
    : 'another daemon';
  return (
    `ours: state directory ${resolve(stateDir)} is already owned by ${who}.\n` +
    '      Two daemons must NEVER share a state directory — concurrent writers\n' +
    '      corrupt identity packets and key material. Give this one its own:\n' +
    '        OURS_PORT=<free-port> OURS_STATE_DIR=<other-dir> ours-mcp start\n' +
    `      To take over instead, stop the owner first:  ours-mcp stop\n` +
    `      (lock file: ${stateLockPath(stateDir)})`
  );
}

// ----- post-start verification -----------------------------------------------

export type VerifyResult =
  | { ok: true; info: DaemonIdentity }
  | { ok: false; reason: 'unreachable' | 'foreign' | 'wrong-state' | 'wrong-instance'; info: DaemonIdentity | null; message: string };

// Confirm the daemon answering on `port` is the one we meant.
//
// This is the fix for the false success: `start` used to conclude "up" from the
// mere fact that the port answered, so when its own child died on EADDRINUSE it
// happily reported somebody else's daemon as ours. Liveness is not identity.
export async function verifyDaemon(
  port: number,
  expected: { stateDir: string; instance?: string },
): Promise<VerifyResult> {
  const info = await probeDaemonInfo(port);
  if (!info) {
    return {
      ok: false,
      reason: (await portOpen(port)) ? 'foreign' : 'unreachable',
      info: null,
      message: (await portOpen(port))
        ? `port ${port} is answering but did not identify itself as an ours daemon.`
        : `nothing is answering on port ${port}.`,
    };
  }
  if (!sameStateDir(info, expected.stateDir)) {
    return {
      ok: false,
      reason: 'wrong-state',
      info,
      message:
        `port ${port} is served by a DIFFERENT ours daemon (${describe(info)}) — ` +
        `expected state ${resolve(expected.stateDir)}.`,
    };
  }
  // Same state dir but a different label means the operator's OURS_INSTANCE and
  // the running daemon disagree about which daemon this is. The endpoint is
  // right, so this is a naming conflict, not a wrong-daemon connection.
  if (expected.instance && info.instance && info.instance !== expected.instance) {
    return {
      ok: false,
      reason: 'wrong-instance',
      info,
      message:
        `port ${port} is served by instance "${info.instance}", but OURS_INSTANCE ` +
        `selects "${expected.instance}" (same state dir ${resolve(expected.stateDir)}).`,
    };
  }
  return { ok: true, info };
}
