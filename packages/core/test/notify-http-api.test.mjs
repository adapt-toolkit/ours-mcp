// notify-http-api — Part A: `ours-mcp watch` streams wake events over the
// daemon's local HTTP API, NOT by polling notifications.log on disk.
//
// Root cause of the "deaf agent": on a multi-user host the daemon's
// notifications.log lives under its owner's 0700 home, so a watch run by a
// DIFFERENT OS user gets EACCES and the old file-poll loop swallowed it
// silently → banner prints, session never wakes. Fix: the daemon (which owns
// the file) exposes it over a per-identity long-poll endpoint; watch consumes
// that. File polling is a fallback only, and any EACCES/ENOENT there must fail
// LOUDLY (non-zero exit), never spin.
//
// We model a "cross-user" watcher as one that (a) reaches the port with a valid
// token but (b) cannot see the daemon's files — simulated by pointing the watch
// process at a BOGUS empty state dir. If the event still arrives, it came over
// the API, not the file.
//
// Self-contained: spawns the BUILT daemon + `ours-mcp watch`. Run after build.

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, appendFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'dist', 'cli.js');
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓', m)) : (fail++, console.log('  ✗ FAIL:', m)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

function startDaemon(port, dir, extraEnv) {
  return spawn('node', [CLI, 'serve'], {
    env: { ...process.env, OURS_TRANSPORT: 'http', OURS_PORT: String(port), OURS_STATE_DIR: dir, OURS_BROKER_URL: 'ws://127.0.0.1:59997/nobroker', ...extraEnv },
    stdio: 'ignore', detached: true,
  });
}
async function waitVersion(port, maxMs = 30_000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/version`)).ok) return true; } catch { /* not yet */ }
    await sleep(250);
  }
  return false;
}
const kill = (d) => { try { process.kill(-d.pid, 'SIGKILL'); } catch { /* gone */ } };
const notifyLine = (o) => JSON.stringify(o) + '\n';

console.log('notify-http-api\n');

// ─── endpoint + watch-over-API (the cross-user live-repro) ───────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'a2a-notif-'));
  const bogus = mkdtempSync(join(tmpdir(), 'a2a-notif-bogus-')); // watcher's unreadable-of-real-files stand-in
  const PORT = await freePort();
  const d = startDaemon(PORT, dir, {}); // owner mode (default)
  let watcher;
  try {
    const up = await waitVersion(PORT);
    ok(up, 'daemon boots');
    if (!up) throw new Error('daemon did not boot');
    const token = readFileSync(join(dir, 'daemon-token'), 'utf8').trim();

    // An identity dir with a notifications.log (as the daemon lays it out).
    const aliceDir = join(dir, 'Alice');
    mkdirSync(aliceDir, { recursive: true });
    const logPath = join(aliceDir, 'notifications.log');
    appendFileSync(logPath, ''); // create empty

    // (1) endpoint requires the token.
    const unauth = await fetch(`http://127.0.0.1:${PORT}/identities/Alice/notifications?since=0`);
    ok(unauth.status === 401, '(1) notifications endpoint without token → 401');

    // (2) immediate read: an already-present event is returned from `since=0`.
    appendFileSync(logPath, notifyLine({ event: 'message_received', from: 'Bob', msg_id: 1, date: '2026-07-06T00:00:00Z' }));
    const r2 = await fetch(`http://127.0.0.1:${PORT}/identities/Alice/notifications?since=0`, { headers: { 'x-ours-api-token': token } });
    const b2 = await r2.json();
    ok(r2.status === 200 && Array.isArray(b2.events) && b2.events.length === 1 && b2.events[0].from === 'Bob',
      '(2) endpoint returns the existing event from since=0');
    ok(typeof b2.cursor === 'number' && b2.cursor > 0, '(2) endpoint returns a numeric byte cursor');

    // (3) long-poll: request holds open, then resolves when a NEW event lands.
    const cursor = b2.cursor;
    const t0 = Date.now();
    const pollP = fetch(`http://127.0.0.1:${PORT}/identities/Alice/notifications?since=${cursor}`, { headers: { 'x-ours-api-token': token } }).then((r) => r.json());
    await sleep(400); // still holding (no data yet)
    appendFileSync(logPath, notifyLine({ event: 'message_received', from: 'Carol', msg_id: 2, date: '2026-07-06T00:01:00Z' }));
    const b3 = await pollP;
    ok(b3.events.length === 1 && b3.events[0].from === 'Carol', '(3) long-poll resolves with the new event');
    ok(Date.now() - t0 >= 350, '(3) long-poll actually held the connection open');

    // (4) `ours-mcp watch Alice` receives events over the API even though its OWN
    //     state dir is bogus/empty — proving it did NOT read the file itself.
    watcher = spawn('node', [CLI, 'watch', 'Alice'], {
      env: { ...process.env, OURS_PORT: String(PORT), OURS_STATE_DIR: bogus, OURS_API_TOKEN: token, OURS_BROKER_URL: 'ws://127.0.0.1:59997/nobroker' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    watcher.stdout.on('data', (c) => { stdout += c.toString(); });
    await sleep(1500); // let watch prime at the current tip
    appendFileSync(logPath, notifyLine({ event: 'message_received', from: 'Dave', msg_id: 3, date: '2026-07-06T00:02:00Z' }));
    // wait for the line to surface
    for (let i = 0; i < 40 && !/Dave/.test(stdout); i++) await sleep(150);
    ok(/\[Alice\] new message from Dave \(#3\)/.test(stdout),
      '(4) watch emits the API-delivered event with the IDENTICAL legacy format');
    ok(!/Bob|Carol/.test(stdout), '(4) watch primed at the tip — no backlog replay');
  } finally {
    if (watcher) { try { watcher.kill('SIGKILL'); } catch { /* gone */ } }
    kill(d);
    rmSync(dir, { recursive: true, force: true });
    rmSync(bogus, { recursive: true, force: true });
  }
}

// ─── fallback fails LOUDLY: API unreachable + unreadable state dir ───────────
// The old behavior silently spun forever (deaf agent). Now: a clear one-line
// error + non-zero exit, so a watcher that cannot watch looks broken, not armed.
{
  const deadPort = await freePort(); // nothing will listen here
  const locked = mkdtempSync(join(tmpdir(), 'a2a-notif-locked-'));
  chmodSync(locked, 0o000); // EACCES on traversal (models the cross-user 0700 home)
  const watcher = spawn('node', [CLI, 'watch', 'Alice'], {
    env: { ...process.env, OURS_PORT: String(deadPort), OURS_STATE_DIR: locked, OURS_BROKER_URL: 'ws://127.0.0.1:59997/nobroker' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  watcher.stderr.on('data', (c) => { stderr += c.toString(); });
  const exit = await new Promise((res) => {
    const timer = setTimeout(() => { try { watcher.kill('SIGKILL'); } catch { /* gone */ } res('TIMEOUT'); }, 10_000);
    watcher.on('exit', (code) => { clearTimeout(timer); res(code); });
  });
  try {
    ok(exit !== 'TIMEOUT', 'fallback does NOT spin forever (process exits)');
    ok(typeof exit === 'number' && exit !== 0, 'fallback exits NON-ZERO when it cannot watch');
    ok(/EACCES|permission|cannot watch|unreadable/i.test(stderr), 'fallback prints a clear one-line error');
  } finally {
    try { chmodSync(locked, 0o700); } catch { /* best effort */ }
    rmSync(locked, { recursive: true, force: true });
  }
}

console.log(`\n${pass}/${pass + fail} passed${fail ? ` (${fail} FAILED)` : ''}`);
process.exit(fail === 0 ? 0 : 1);
