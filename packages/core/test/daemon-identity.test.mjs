// daemon-identity — instance labels, state fingerprints, and the state-directory
// lock that makes "two daemons sharing one state dir" impossible rather than
// merely discouraged.
//
// Pure/local: no daemon is spawned, no port is bound, nothing outside a fresh
// mkdtemp is touched. Drives the REAL shipped functions from dist/, not copies.
//
// Run after `npm run build`.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_INSTANCE,
  EXIT_PORT_COLLISION,
  EXIT_STATE_COLLISION,
  acquireStateLock,
  formatPortCollision,
  formatStateCollision,
  pidAlive,
  readStateLock,
  resolveInstance,
  sameStateDir,
  stateFingerprint,
  stateLockPath,
  validateInstanceName,
} from '../dist/daemon-identity.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓', m)) : (fail++, console.log('  ✗ FAIL:', m)); };
const throws = (fn) => { try { fn(); return null; } catch (e) { return e; } };
const tmp = (tag) => mkdtempSync(join(tmpdir(), `ours-did-${tag}-`));
const cleanup = [];

console.log('daemon-identity\n');

// ─── instance label (the P1 seam: a NAME, never a config bundle) ─────────────
{
  ok(resolveInstance({}).name === DEFAULT_INSTANCE, 'no OURS_INSTANCE → "default"');
  ok(resolveInstance({}).source === 'default', 'unset label reports source "default"');
  ok(resolveInstance({ OURS_INSTANCE: 'work' }).name === 'work', 'OURS_INSTANCE names the daemon');
  ok(resolveInstance({ OURS_INSTANCE: 'work' }).source === 'env', 'env label reports source "env"');
  ok(resolveInstance({ OURS_INSTANCE: '  work  ' }).name === 'work', 'label is trimmed');
  ok(resolveInstance({ OURS_INSTANCE: '' }).name === DEFAULT_INSTANCE, 'empty label falls back to default');

  // A malformed label fails loudly at startup rather than yielding a daemon that
  // answers to a name nobody asked for.
  for (const bad of ['Work', '-lead', 'a'.repeat(33), 'has space', 'ours/work']) {
    ok(throws(() => resolveInstance({ OURS_INSTANCE: bad })) !== null, `rejects malformed label ${JSON.stringify(bad)}`);
  }
  ok(validateInstanceName('work') === null, 'validateInstanceName accepts a legal name');
  ok(/systemd/.test(validateInstanceName('Work') ?? ''), 'the rejection explains the filename/systemd constraint');
}

// ─── state fingerprint: identifies the DIRECTORY, not the path string ────────
{
  const a = tmp('fp-a'); cleanup.push(a);
  const b = tmp('fp-b'); cleanup.push(b);

  ok(stateFingerprint(a) === stateFingerprint(a), 'fingerprint is stable for one directory');
  ok(stateFingerprint(a) !== stateFingerprint(b), 'distinct directories fingerprint differently');
  ok(/^[0-9a-f]{16}$/.test(stateFingerprint(a)), 'fingerprint is a short non-secret hex token');

  // The whole point: two names for one directory must compare EQUAL, because
  // two daemons reaching it by different paths are still sharing one state dir.
  const alias = join(tmp('fp-link'), 'alias');
  cleanup.push(alias);
  symlinkSync(a, alias);
  ok(stateFingerprint(alias) === stateFingerprint(a), 'a symlink alias fingerprints as the SAME directory');
  ok(stateFingerprint(join(a, '..', join(a).split('/').pop())) === stateFingerprint(a), 'a non-normalized path fingerprints as the same directory');

  // Never throws: a directory that does not exist yet still gets a stable value.
  const missing = join(a, 'not-created-yet');
  ok(stateFingerprint(missing) === stateFingerprint(missing), 'a missing directory degrades to a stable path fingerprint');
}

// ─── sameStateDir: fingerprint first, resolved path for older daemons ────────
{
  const a = tmp('same-a'); cleanup.push(a);
  const b = tmp('same-b'); cleanup.push(b);

  ok(sameStateDir({ stateFingerprint: stateFingerprint(a) }, a), 'matching fingerprint → same daemon');
  ok(!sameStateDir({ stateFingerprint: stateFingerprint(b) }, a), 'different fingerprint → different daemon');
  ok(sameStateDir({ stateDir: a }, a), 'no fingerprint (older daemon) falls back to the resolved path');
  ok(!sameStateDir({ stateDir: b }, a), 'path fallback still distinguishes two daemons');
  ok(!sameStateDir({}, a), 'a daemon that identifies itself with neither is never assumed to be ours');
}

// ─── the state lock ──────────────────────────────────────────────────────────
{
  const dir = tmp('lock'); cleanup.push(dir);
  const meta = { pid: process.pid, port: 3050, instance: 'default', version: '0.0.0-test' };

  const first = acquireStateLock(dir, meta);
  ok(first.ok, 'first daemon acquires the state lock');
  ok(existsSync(stateLockPath(dir)), 'the lock file exists while held');

  const record = readStateLock(dir);
  ok(record?.pid === process.pid, 'the lock records the holding pid');
  ok(record?.port === 3050 && record?.instance === 'default', 'the lock records the port and instance');
  ok(record?.stateFingerprint === stateFingerprint(dir), 'the lock records the state fingerprint');
  ok(typeof record?.startedAt === 'string', 'the lock records when the holder started');

  const second = acquireStateLock(dir, { ...meta, pid: process.pid, port: 3060 });
  ok(!second.ok, 'a SECOND daemon is refused the same state directory');
  ok(second.ok === false && second.holder?.pid === process.pid, 'the refusal names the live holder');
  ok(readStateLock(dir)?.port === 3050, 'the refused daemon did not overwrite the holder record');

  first.release();
  ok(!existsSync(stateLockPath(dir)), 'release removes the lock file');
  const third = acquireStateLock(dir, meta);
  ok(third.ok, 'the directory is acquirable again once released');
  third.release();
}

// ─── a crashed daemon must not wedge its own state dir forever ───────────────
{
  const dir = tmp('stale'); cleanup.push(dir);
  // A genuinely dead pid: spawn, wait for exit, then reuse its (now reaped) pid.
  const corpse = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
  const deadPid = corpse.pid;
  ok(!pidAlive(deadPid), 'the test corpse pid really is dead');
  ok(pidAlive(process.pid), 'pidAlive recognises a live process');
  ok(!pidAlive(0) && !pidAlive(-1), 'pidAlive rejects nonsense pids');

  mkdirSync(dir, { recursive: true });
  writeFileSync(
    stateLockPath(dir),
    JSON.stringify({ pid: deadPid, port: 3050, instance: 'default', stateDir: dir, stateFingerprint: 'x', version: '0', startedAt: 'then' }),
  );
  const taken = acquireStateLock(dir, { pid: process.pid, port: 3050, instance: 'default', version: '0.0.0-test' });
  ok(taken.ok, 'a lock left by a DEAD holder is reclaimed');
  ok(readStateLock(dir)?.pid === process.pid, 'the reclaimed lock records the new holder');
  taken.release();

  // A corrupt lock names no pid to check; refusing forever would wedge the dir.
  writeFileSync(stateLockPath(dir), 'not json at all');
  const afterCorrupt = acquireStateLock(dir, { pid: process.pid, port: 3050, instance: 'default', version: '0.0.0-test' });
  ok(afterCorrupt.ok, 'a corrupt lock file is reclaimed rather than wedging the state dir');
  afterCorrupt.release();
}

// ─── release only ever removes OUR lock ──────────────────────────────────────
{
  const dir = tmp('release'); cleanup.push(dir);
  const mine = acquireStateLock(dir, { pid: process.pid, port: 3050, instance: 'default', version: '0.0.0-test' });
  ok(mine.ok, 'acquired for the release-safety check');
  // Simulate a reclaim race: someone else's record is now in our lock file.
  writeFileSync(
    stateLockPath(dir),
    JSON.stringify({ pid: process.pid + 1, port: 3060, instance: 'other', stateDir: dir, stateFingerprint: 'y', version: '0', startedAt: 'now' }),
  );
  mine.release();
  ok(readStateLock(dir)?.instance === 'other', 'release does NOT delete a lock another daemon now owns');
  rmSync(stateLockPath(dir), { force: true });
}

// ─── the messages have to tell you what to do ────────────────────────────────
{
  const dir = tmp('msg'); cleanup.push(dir);
  const other = { instance: 'work', stateDir: '/tmp/other-state', pid: 4711, version: '0.16.0' };

  const differentDaemon = formatPortCollision(3050, dir, { kind: 'ours', info: other, sameState: false });
  ok(/instance "work"/.test(differentDaemon), 'a port collision names the instance holding the port');
  ok(/\/tmp\/other-state/.test(differentDaemon) && /pid 4711/.test(differentDaemon), 'it names the other state dir and pid');
  ok(/OURS_PORT=.*OURS_STATE_DIR=/.test(differentDaemon), 'it prescribes a different port AND state dir together');

  const foreign = formatPortCollision(3050, dir, { kind: 'foreign' });
  ok(/non-ours service/.test(foreign), 'a non-ours listener is reported as such');
  ok(/lsof/.test(foreign), 'and points at how to find the holder');

  const already = formatPortCollision(3050, dir, { kind: 'ours', info: other, sameState: true });
  ok(/already running/.test(already), 'our own daemon on our own port reads as "already running", not a collision');

  const stateMsg = formatStateCollision(dir, { pid: 99, port: 3060, instance: 'work', startedAt: 'T' });
  ok(/NEVER share/.test(stateMsg), 'a state collision says sharing is forbidden, not merely inadvisable');
  ok(/pid 99/.test(stateMsg) && /port 3060/.test(stateMsg), 'it names the owning pid and port');
  ok(stateMsg.includes(stateLockPath(dir)), 'it names the lock file so a truly stale one can be removed');
  ok(!/share.*state.*dir.*instead/i.test(stateMsg), 'it never offers sharing as an option');

  ok(EXIT_PORT_COLLISION === 3 && EXIT_STATE_COLLISION === 4, 'collision exit codes are distinct from a generic failure');
}

for (const dir of cleanup) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }

console.log(`\ndaemon-identity: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
