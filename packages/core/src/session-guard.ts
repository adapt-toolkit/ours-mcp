/**
 * Cross-process coordination guard for native session records.
 * Uses SQLite BEGIN EXCLUSIVE on a permanent guard file adjacent to
 * the JSON record, following the SDK acquireStateRootLock pattern.
 *
 * OS-released: process death closes the SQLite connection and
 * releases the exclusive lock. The guard inode is permanent.
 */

import { createHash } from 'node:crypto';
import { openSync, closeSync, lstatSync, mkdirSync, chmodSync, constants } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const BUSY_TIMEOUT_MS = 5000;

interface DatabaseLike {
  exec(sql: string): void;
  close(): void;
}

type DatabaseConstructor = new (path: string) => DatabaseLike;

let DatabaseSync: DatabaseConstructor | null = null;
let resolveAttempted = false;

function resolveDatabase(): DatabaseConstructor {
  if (DatabaseSync) return DatabaseSync;
  if (resolveAttempted) throw new Error('No SQLite implementation available for native session guard');
  resolveAttempted = true;
  try {
    const mod = createRequire(import.meta.url)('node:sqlite');
    DatabaseSync = mod.DatabaseSync;
    return DatabaseSync!;
  } catch {
    try {
      const mod = createRequire(import.meta.url)('better-sqlite3');
      DatabaseSync = mod.default ?? mod;
      return DatabaseSync!;
    } catch {
      throw new Error('Native session guard requires node:sqlite (Node >=22.13) or better-sqlite3');
    }
  }
}

function ensureGuardFile(guardPath: string): void {
  try {
    const fd = openSync(guardPath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    closeSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const stat = lstatSync(guardPath);
  if (!stat.isFile() || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0 || stat.nlink !== 1) {
    throw new Error('Native session guard file must be an owner-only regular file');
  }
}

/**
 * Acquire a cross-process exclusive lock on the guard file.
 * Returns a release function. The lock is also released on process death.
 */
export function acquireSessionGuard(recordPath: string): () => void {
  const uid = process.getuid!();
  const base = join(`/tmp/ours-${uid}`, 'session-guards');
  mkdirSync(base, { recursive: true, mode: 0o700 });
  try { chmodSync(base, 0o700); } catch { /* race */ }
  const hash = createHash('sha256').update(recordPath).digest('hex');
  const guardPath = join(base, `${hash}.guard`);
  ensureGuardFile(guardPath);
  const before = lstatSync(guardPath);
  const Database = resolveDatabase();
  const db = new Database(guardPath);
  try {
    const after = lstatSync(guardPath);
    if (before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode || before.uid !== after.uid) {
      throw new Error('Native session guard file changed during acquisition');
    }
    db.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}; BEGIN EXCLUSIVE`);
    return () => { try { db.close(); } catch { /* already closed */ } };
  } catch (error) {
    try { db.close(); } catch { /* cleanup */ }
    throw error;
  }
}
