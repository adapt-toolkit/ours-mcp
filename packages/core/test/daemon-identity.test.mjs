// daemon-identity — instance labels, state fingerprints, and the state-directory
// lock that makes "two daemons sharing one state dir" impossible rather than
// merely discouraged.
//
// Pure/local: no daemon is spawned, no port is bound, nothing outside a fresh
// mkdtemp is touched. Drives the REAL shipped functions from dist/, not copies.
//
// Run after `npm run build`.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  DEFAULT_INSTANCE,
  EXIT_PORT_COLLISION,
  EXIT_STATE_COLLISION,
  acquireStateLock,
  formatPortCollision,
  formatStateCollision,
  killErrorMeansDead,
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

// ─── reclaiming a stale lock may never destroy a LIVE one ────────────────────
// The race being regressed: two contenders both read the same DEAD record and
// both conclude "stale". The first reclaims it and acquires. The second, still
// acting on its now-obsolete read, deletes that LIVE lock and acquires too —
// two owners of one state directory, which is the exact corruption the lock
// exists to prevent.
//
// Reproduced deterministically through the beforeReclaim seam, which fires in
// precisely the window the race lives in (stale observed, not yet reclaimed).
// No sleeps, no load, no thread scheduling: the interleaving is constructed.
{
  const dir = tmp('race'); cleanup.push(dir);
  const corpse = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
  const stale = (pid) => JSON.stringify({
    pid, port: 3050, instance: 'ghost', stateDir: dir, stateFingerprint: 'x', version: '0', startedAt: 'then',
  });
  const live = JSON.stringify({
    pid: process.pid, port: 3061, instance: 'winner', stateDir: dir, stateFingerprint: 'x', version: '0', startedAt: 'now',
  });

  mkdirSync(dir, { recursive: true });
  writeFileSync(stateLockPath(dir), stale(corpse.pid));

  let fired = 0;
  const loser = acquireStateLock(
    dir,
    { pid: process.pid, port: 3062, instance: 'loser', version: '0.0.0-test' },
    { beforeReclaim: () => { if (!fired++) writeFileSync(stateLockPath(dir), live); } },
  );

  ok(fired === 1, 'the seam fired: the contender really did take the stale-reclaim path');
  ok(loser.ok === false, 'a contender that loses the reclaim race does NOT become a second owner');
  ok(loser.ok === false && loser.holder?.instance === 'winner', 'and it reports the LIVE holder it collided with');
  const survivor = readStateLock(dir);
  ok(survivor?.instance === 'winner' && survivor?.port === 3061, "the winner's live lock survived — it was not deleted");
  ok(
    readdirSync(dir).filter((f) => f.includes('.reclaim-')).length === 0,
    'the compare-safe reclaim leaves no temporary lock copies behind',
  );
  rmSync(stateLockPath(dir), { force: true });

  // The other half of the contract: when the record really IS stale throughout,
  // reclamation still works. A lock that only ever refuses wedges the directory.
  writeFileSync(stateLockPath(dir), stale(corpse.pid));
  let alsoFired = 0;
  const winner = acquireStateLock(
    dir,
    { pid: process.pid, port: 3063, instance: 'reclaimer', version: '0.0.0-test' },
    { beforeReclaim: () => { alsoFired++; } },
  );
  ok(alsoFired === 1 && winner.ok, 'an uncontested stale lock is still reclaimed');
  ok(readStateLock(dir)?.instance === 'reclaimer', 'and the reclaimer becomes the recorded holder');
  winner.release();
}

// ─── exactly one winner when real processes race one stale lock ──────────────
// The seam above proves the dangerous interleaving; this proves the property
// end-to-end with no seam at all: N separate OS processes, started together,
// all pointed at one stale lock. Exactly one may acquire.
{
  const dir = tmp('nway'); cleanup.push(dir);
  const corpse = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    stateLockPath(dir),
    JSON.stringify({ pid: corpse.pid, port: 3050, instance: 'ghost', stateDir: dir, stateFingerprint: 'x', version: '0', startedAt: 'then' }),
  );

  const modUrl = pathToFileURL(new URL('../dist/daemon-identity.js', import.meta.url).pathname).href;
  const contender = `
    import(${JSON.stringify(modUrl)}).then((m) => {
      const r = m.acquireStateLock(${JSON.stringify(dir)}, { pid: process.pid, port: 3050, instance: 'c' + process.pid, version: '0' });
      process.stdout.write(JSON.stringify({ ok: r.ok, holder: r.ok ? null : (r.holder && r.holder.instance) }));
      // Hold the lock: releasing would let a later contender legitimately win.
      if (r.ok) setTimeout(() => {}, 3000);
    });
  `;
  const kids = Array.from({ length: 6 }, () => spawn(process.execPath, ['-e', contender], { stdio: ['ignore', 'pipe', 'ignore'] }));
  const outs = await Promise.all(kids.map((k) => new Promise((res) => {
    let buf = '';
    k.stdout.on('data', (d) => { buf += d; });
    k.on('close', () => res(buf));
  })));
  const results = outs.map((o) => { try { return JSON.parse(o); } catch { return null; } }).filter(Boolean);
  const winners = results.filter((r) => r.ok);
  ok(results.length === 6, `all 6 contenders reported a verdict (got ${results.length})`);
  ok(winners.length === 1, `exactly ONE of 6 racing processes acquires the stale lock (got ${winners.length})`);
  ok(
    results.filter((r) => !r.ok).every((r) => typeof r.holder === 'string' && r.holder.startsWith('c')),
    'every loser observed a live holder rather than silently failing',
  );
  ok(
    readdirSync(dir).filter((f) => f.includes('.reclaim-')).length === 0,
    'no reclaim temporaries are left behind by a real race',
  );
  rmSync(stateLockPath(dir), { force: true });
}

// ─── cross-user pids: EPERM means ALIVE, only ESRCH means dead ───────────────
// kill(pid, 0) against another user's process raises EPERM — the process EXISTS,
// we simply may not signal it. Reading that as "dead" would reclaim a live
// cross-user daemon's state lock. Proven through the injectable probe, because
// creating a process owned by another user is not available to a test.
{
  const raise = (code) => () => { const e = new Error(code); e.code = code; throw e; };
  const noProc = () => { throw new Error('/proc unavailable'); };

  ok(pidAlive(4242, { kill: raise('EPERM'), readProcStat: noProc }) === true,
     'EPERM from kill(pid,0) means the process exists but is another user\'s: ALIVE');
  ok(pidAlive(4242, { kill: raise('ESRCH'), readProcStat: noProc }) === false,
     'ESRCH is the ONLY errno that means dead');
  ok(pidAlive(4242, { kill: raise('EINVAL'), readProcStat: noProc }) === true,
     'an unexpected errno fails safe: treated as alive, never reclaimed');
  ok(pidAlive(4242, { kill: raise(undefined), readProcStat: noProc }) === true,
     'an errno-less throw also fails safe');
  ok(killErrorMeansDead({ code: 'ESRCH' }) === true, 'killErrorMeansDead: ESRCH → dead');
  ok(killErrorMeansDead({ code: 'EPERM' }) === false, 'killErrorMeansDead: EPERM → not dead');
  ok(killErrorMeansDead(undefined) === false, 'killErrorMeansDead: a non-error fails safe');

  // The /proc fallback must not launder EPERM into "dead" either: the first
  // signal succeeds, /proc is unreadable, and the re-probe then raises EPERM.
  let calls = 0;
  const flaky = {
    kill: () => { if (calls++ === 0) return; const e = new Error('EPERM'); e.code = 'EPERM'; throw e; },
    readProcStat: noProc,
  };
  ok(pidAlive(4242, flaky) === true, 'an unreadable /proc plus EPERM on re-probe still reads as alive');

  // And a REAL cross-user process, for the non-injected path: pid 1 is root-owned,
  // so kill(1, 0) raises EPERM for any non-root caller. Before the fix this
  // returned false, i.e. init was classified as a corpse.
  ok(pidAlive(1) === true, 'pidAlive treats the live cross-user process pid 1 as alive');

  // End-to-end: a lock held by a live cross-user pid must be refused, not reclaimed.
  const dir = tmp('crossuser'); cleanup.push(dir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    stateLockPath(dir),
    JSON.stringify({ pid: 1, port: 3050, instance: 'root-owned', stateDir: dir, stateFingerprint: 'x', version: '0', startedAt: 'then' }),
  );
  const refused = acquireStateLock(dir, { pid: process.pid, port: 3050, instance: 'default', version: '0.0.0-test' });
  ok(refused.ok === false, 'a lock held by a live cross-user pid is REFUSED, not reclaimed');
  ok(refused.ok === false && refused.holder?.instance === 'root-owned', 'and the refusal names that holder');
  ok(readStateLock(dir)?.pid === 1, 'the cross-user lock file is left intact');
  rmSync(stateLockPath(dir), { force: true });
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
