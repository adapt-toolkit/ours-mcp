// lock-race — the state lock under real concurrency.
//
// The state lock has exactly one job: of N daemons aimed at one state directory,
// EXACTLY ONE may end up owning it. Two separate windows could produce a second
// owner, and both needed closing:
//
//   ZERO-BYTE WINDOW (needs no stale lock at all — a CLEAN directory is enough)
//     open(path,'wx') is atomic for creation but not for content: it leaves a
//     zero-byte file that only becomes a record on the next write. A contender
//     arriving inside that gap reads an empty file, parses it as corrupt, finds
//     no pid to test for liveness, classifies the live winner's lock as garbage,
//     removes it, and acquires.
//
//   STALE-RECLAIM TOCTOU
//     Two contenders both read the same dead record, both conclude "stale"; the
//     slower one's unconditional remove deletes the faster one's NEW LIVE lock.
//
// Both are timing bugs, so this file measures rather than argues: many trials,
// many racers, counting winners. It is deliberately the crude version of the
// proof — no seams, no injection, just processes.
//
// Pure/local: no daemon, no port, no network. Every directory is a fresh mkdtemp.
// Run after `npm run build`.

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MOD = pathToFileURL(join(HERE, '..', 'dist', 'daemon-identity.js')).href;

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓', m)) : (fail++, console.log('  ✗ FAIL:', m)); };
const dirs = [];
const tmp = (tag) => { const d = mkdtempSync(join(tmpdir(), `ours-race-${tag}-`)); dirs.push(d); return d; };

console.log('lock-race\n');

// Guard: never race against anything but a fresh temp dir.
{
  const probe = tmp('guard');
  ok(resolve(probe).startsWith(resolve(tmpdir())), 'guard: race directories are under tmpdir');
  if (!resolve(probe).startsWith(resolve(tmpdir()))) process.exit(1);
}

// One racer process: acquire, report, then WAIT FOR THE PARENT'S RELEASE SENTINEL.
//
// Holding matters, but holding for a FIXED DURATION is a bug that manufactures the
// very defect this file tests for. A winner that exits after N seconds leaves a
// lock whose owner is genuinely dead; a racer that started later then CORRECTLY
// reclaims it — and the harness scores that correct behaviour as a double-win.
// The result is skew-dependent, so it is both a false alarm and a flaky gate.
//
// Lengthening the timeout only moves the threshold; it does not remove the
// dependence on scheduling. So the winner blocks on a sentinel file that the
// parent writes ONLY after every racer has reported its verdict. No lock is ever
// released while a contender is still to attempt. The absolute deadline below is
// a deadlock backstop for a parent that died, never the mechanism.
const RACER = (dir, releasePath) => `
  const fs = require('fs');
  import(${JSON.stringify(MOD)}).then((m) => {
    const r = m.acquireStateLock(${JSON.stringify(dir)}, { pid: process.pid, port: 3050, instance: 'r' + process.pid, version: '0' });
    process.stdout.write(JSON.stringify({
      ok: r.ok,
      pid: process.pid,
      holder: r.ok ? null : (r.holder ? r.holder.pid : null),
      holderInstance: r.ok ? null : (r.holder ? r.holder.instance : null),
    }));
    if (!r.ok) return;
    const deadline = Date.now() + 120000; // backstop only: parent died
    const wait = () => {
      if (fs.existsSync(${JSON.stringify(releasePath)}) || Date.now() > deadline) return;
      setTimeout(wait, 10);
    };
    wait();
  }).catch((e) => process.stdout.write(JSON.stringify({ ok: false, error: String(e && e.message) })));
`;

// Start all racers as close together as possible, collect every verdict, and only
// then release the winner. Two phases, in this order, because the ordering IS the
// barrier: verdicts first, release second.
let raceSeq = 0;
async function race(dir, racers) {
  const releasePath = join(dir, `.release-${raceSeq++}`);
  const kids = Array.from({ length: racers }, () =>
    spawn(process.execPath, ['-e', RACER(dir, releasePath)], { stdio: ['ignore', 'pipe', 'ignore'] }));

  // A racer writes its verdict BEFORE waiting on the sentinel, so every verdict is
  // readable while the winner is still holding.
  const verdicts = await Promise.all(kids.map((k) => new Promise((res) => {
    let buf = '';
    k.stdout.on('data', (d) => {
      buf += d;
      try { res(JSON.parse(buf)); } catch { /* keep reading */ }
    });
    k.on('close', () => { try { res(JSON.parse(buf)); } catch { res({ ok: false, error: 'no verdict: ' + buf.slice(0, 80) }); } });
  })));

  writeFileSync(releasePath, '');            // every racer has reported — winner may exit
  await Promise.all(kids.map((k) => new Promise((res) => (k.exitCode === null ? k.on('close', res) : res()))));
  return verdicts;
}

const deadPid = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' }).pid;
const staleRecord = (dir) => JSON.stringify({
  pid: deadPid, port: 3050, instance: 'ghost', stateDir: dir,
  stateFingerprint: 'x', version: '0', startedAt: 'then',
});

// Trial counts. The verifier reproduced dual winners at 60 trials; these are the
// same shape, sized so the whole file stays inside a normal suite budget.
const TRIALS = Number(process.env.OURS_RACE_TRIALS || 24);

// ─── 1. stale-seeded: N racers, one pre-existing DEAD lock ───────────────────
for (const racers of [2, 4, 8]) {
  const winners = [];
  const noVerdict = [];
  const badLoser = [];
  for (let t = 0; t < TRIALS; t++) {
    const dir = tmp(`stale-${racers}-${t}`);
    writeFileSync(join(dir, 'daemon.lock'), staleRecord(dir));
    const results = await race(dir, racers);
    const won = results.filter((r) => r.ok);
    winners.push(won.length);
    if (results.length !== racers || results.some((r) => r.error)) noVerdict.push(t);
    // Every loser must have OBSERVED a holder, not merely failed.
    if (results.some((r) => !r.ok && !r.error && r.holder === null)) badLoser.push(t);
  }
  const worst = Math.max(...winners);
  const multi = winners.filter((w) => w !== 1).length;
  ok(
    multi === 0,
    `stale-seeded, ${racers} racers x${TRIALS}: exactly one winner every trial ` +
      `(worst ${worst}, bad trials ${multi})`,
  );
  ok(noVerdict.length === 0, `stale-seeded, ${racers} racers: every racer reported a verdict`);
  ok(badLoser.length === 0, `stale-seeded, ${racers} racers: every loser observed the live holder`);
}

// ─── 2. CLEAN directory: the zero-byte window, which needs no stale lock ─────
for (const racers of [2, 4, 8]) {
  const winners = [];
  for (let t = 0; t < TRIALS; t++) {
    const dir = tmp(`clean-${racers}-${t}`);
    const results = await race(dir, racers);
    winners.push(results.filter((r) => r.ok).length);
  }
  const worst = Math.max(...winners);
  const multi = winners.filter((w) => w !== 1).length;
  ok(
    multi === 0,
    `CLEAN dir, ${racers} racers x${TRIALS}: exactly one winner every trial ` +
      `(worst ${worst}, bad trials ${multi})`,
  );
}

// ─── 3. a LIVE holder must yield exactly zero winners ────────────────────────
// Same lifetime defect, opposite direction. This holder used to live for a fixed
// 30 s; if it died before the trials below finished, every later racer would
// CORRECTLY acquire the now-unowned directory and "exactly zero winners" would
// fail spuriously. That is the safe direction — a false alarm rather than a false
// pass — but it is the same bug, so it gets the same cure: the holder lives until
// the parent releases it, not until a clock runs out.
{
  const dir = tmp('live');
  const holderRelease = join(dir, '.release-holder');
  const held = spawn(process.execPath, ['-e', `
    const fs = require('fs');
    import(${JSON.stringify(MOD)}).then((m) => {
      const r = m.acquireStateLock(${JSON.stringify(dir)}, { pid: process.pid, port: 3050, instance: 'owner', version: '0' });
      process.stdout.write(JSON.stringify({ ok: r.ok }));
      if (!r.ok) return;
      const deadline = Date.now() + 600000; // backstop only: parent died
      const wait = () => {
        if (fs.existsSync(${JSON.stringify(holderRelease)}) || Date.now() > deadline) return;
        setTimeout(wait, 25);
      };
      wait();
    });
  `], { stdio: ['ignore', 'pipe', 'ignore'] });
  const first = await new Promise((res) => {
    let buf = '';
    held.stdout.on('data', (d) => { buf += d; if (buf) res(JSON.parse(buf)); });
  });
  ok(first.ok === true, 'the live holder acquired the directory');

  let winners = 0;
  for (const racers of [2, 4, 8]) {
    for (let t = 0; t < TRIALS; t++) {
      winners += (await race(dir, racers)).filter((r) => r.ok).length;
    }
  }
  // Prove the holder was still alive for the WHOLE run before trusting the zero.
  // Otherwise "no winners" could mean "nobody raced a live holder at all".
  const holderStillLive = held.exitCode === null;
  ok(holderStillLive, 'the live holder survived every trial, so the zero above is about a LIVE lock');
  ok(winners === 0, `against a LIVE holder, ${TRIALS * 3} trials produced exactly zero winners (got ${winners})`);
  writeFileSync(holderRelease, '');
  held.kill('SIGKILL');
}

// ─── 3b. the zero-byte window, observed directly ─────────────────────────────
// Counting winners is a weak detector for this one: the gap between open('wx')
// and write() is microseconds, while process startup jitter is milliseconds, so
// N racing processes almost never land inside it. (Measured: the racer trials
// above pass on the BUGGY build for the clean-dir case.) Absence of evidence
// from a detector that cannot see the thing is not evidence of absence.
//
// So observe the window itself instead of its consequences: spin a watcher on
// the lock path while the lock is acquired and released thousands of times, and
// count how often the file EXISTS but does not parse into a record. Under the
// old create-then-write that state is reachable and gets caught; under atomic
// publish it is unreachable by construction and the count must be exactly zero.
{
  const dir = tmp('window');
  const lockPath = join(dir, 'daemon.lock');
  const WATCH_MS = 4000;

  const watcher = spawn(process.execPath, ['-e', `
    const fs = require('fs');
    let existed = 0, malformed = 0;
    const deadline = Date.now() + ${WATCH_MS};
    while (Date.now() < deadline) {
      let buf;
      try { buf = fs.readFileSync(${JSON.stringify(lockPath)}, 'utf8'); } catch { continue; }
      existed++;
      let good = false;
      try { const r = JSON.parse(buf); good = !!r && typeof r.pid === 'number'; } catch { /* malformed */ }
      if (!good) malformed++;
    }
    process.stdout.write(JSON.stringify({ existed, malformed }));
  `], { stdio: ['ignore', 'pipe', 'ignore'] });

  const churn = spawn(process.execPath, ['-e', `
    import(${JSON.stringify(MOD)}).then((m) => {
      const deadline = Date.now() + ${WATCH_MS};
      let cycles = 0;
      while (Date.now() < deadline) {
        const r = m.acquireStateLock(${JSON.stringify(dir)}, { pid: process.pid, port: 3050, instance: 'churn', version: '0' });
        if (r.ok) { cycles++; r.release(); }
      }
      process.stdout.write(String(cycles));
    });
  `], { stdio: ['ignore', 'pipe', 'ignore'] });

  const [watchOut, churnOut] = await Promise.all([watcher, churn].map((k) => new Promise((res) => {
    let buf = '';
    k.stdout.on('data', (d) => { buf += d; });
    k.on('close', () => res(buf));
  })));

  const cycles = Number(churnOut) || 0;
  let obs = null;
  try { obs = JSON.parse(watchOut); } catch { /* reported below */ }
  ok(cycles > 100, `the churn loop exercised the lock enough to matter (${cycles} acquire/release cycles)`);
  ok(obs !== null && obs.existed > 100, `the watcher actually observed the lock file (${obs?.existed ?? 0} reads saw it present)`);
  ok(
    obs !== null && obs.malformed === 0,
    `the lock is NEVER observable in a partial state: ${obs?.malformed ?? '?'} malformed reads ` +
      `out of ${obs?.existed ?? '?'} that found the file present`,
  );
}

// ─── 4. no temporaries survive a race ────────────────────────────────────────
{
  const dir = tmp('litter');
  writeFileSync(join(dir, 'daemon.lock'), staleRecord(dir));
  await race(dir, 8);
  // The harness's own release sentinel lives here too; it is ours, not the lock's.
  const litter = readdirSync(dir).filter((f) => f !== 'daemon.lock' && !f.startsWith('.release-'));
  ok(litter.length === 0, `a contested race leaves no temporary files (found: ${litter.join(', ') || 'none'})`);
}

for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
console.log(`\nlock-race: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
