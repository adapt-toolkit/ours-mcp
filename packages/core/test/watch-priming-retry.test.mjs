// watch-priming-retry — `ours-mcp watch` (all identities) must SURVIVE a transient
// failure while priming a newly discovered identity's stream.
//
// THE DEFECT. watchIdentityViaApi primed its cursor OUTSIDE its retry loop:
//
//     let cursor = (await fetchSince('tip')).cursor ?? 0;   // no try/catch
//     for (;;) { try { ...poll... } catch { ...backoff, retry... } }
//
// fetchSince throws on any non-OK, non-401 response and on any network error, so a
// daemon that was merely restarting when the watch armed killed the watch — the
// exact transient case the loop below it exists to survive.
//
// In the all-identities path that failure is worse than a dead stream. The call is
// detached (`void watchIdentityViaApi(name)`) so each identity can stream
// concurrently, which means no caller awaits it and main()'s .catch cannot see it.
// On Node >=15 an unhandled rejection TERMINATES THE PROCESS: one identity's
// hiccup silently took down the streams for every other identity being watched.
// And because `watching.add(name)` runs first, even a surviving process would
// never re-arm that identity.
//
// This test needs no ours daemon: a fake HTTP server speaks the three endpoints
// watch uses, and fails the FIRST priming request the way a restarting daemon
// would. Run after build (dist/cli.js), like its siblings in this directory.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createSocketServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'dist', 'cli.js');
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓', m)) : (fail++, console.log('  ✗ FAIL:', m)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => {
  const s = createSocketServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

const stateDir = mkdtempSync(join(tmpdir(), 'ours-watch-prime-'));
const port = await freePort();

// How many times the identity's stream has been asked to prime (`since=tip`).
let primeAttempts = 0;
// Held long-poll responses, released once the test has proved the watcher is alive.
const parked = [];

const daemon = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const json = (body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (url.pathname === '/state-dir') return json({ stateDir });
  if (url.pathname === '/identities') return json({ identities: [{ name: 'Alice' }] });
  if (url.pathname === '/identities/Alice/notifications') {
    const since = url.searchParams.get('since');
    if (since === 'tip') {
      primeAttempts += 1;
      // FIRST prime fails the way a restarting daemon does: a 5xx, which
      // fetchSince turns into a throw. Every later prime succeeds.
      if (primeAttempts === 1) { res.writeHead(503); return res.end('restarting'); }
      return json({ cursor: 0, events: [] });
    }
    // A normal long poll: park it so the stream stays open rather than spinning.
    parked.push(res);
    return;
  }
  res.writeHead(404); res.end('{}');
});
await new Promise((r) => daemon.listen(port, '127.0.0.1', r));

// No identity argument: this is the all-identities path, the one with the
// detached call and therefore the one that used to die outright.
const watcher = spawn('node', [CLI, 'watch'], {
  env: {
    ...process.env,
    OURS_PORT: String(port),
    OURS_STATE_DIR: stateDir,
    OURS_BROKER_URL: 'ws://127.0.0.1:59997/nobroker',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stdout = '';
let exited = null;
watcher.stderr.on('data', () => {});
watcher.stdout.on('data', (b) => { stdout += String(b); });
watcher.on('exit', (code) => { exited = code ?? -1; });

// Long enough for: the first prime to fail, the in-loop backoff (1s) to elapse,
// and the retry to succeed. Before the fix the process is gone within the first
// few hundred milliseconds, killed by the unhandled rejection.
await sleep(6000);

ok(exited === null, `the watcher is still running after a transient priming failure (exit=${exited})`);
ok(primeAttempts >= 2, `priming was RETRIED rather than abandoned (attempts=${primeAttempts})`);

// SURVIVING IS NOT ENOUGH — the re-primed stream has to actually deliver. Release
// the parked long poll with a real arrival and require the wake on stdout.
//
// (Deliberately NOT asserted from stderr: this bundle is built with minify, so an
// uncaught rejection prints one enormous source line that happens to contain every
// string literal in the file. A stderr regex would pass in both directions and
// prove nothing. Behaviour discriminates; text does not.)
const deliver = parked.splice(0);
for (const res of deliver) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ cursor: 1, events: [{ event: 'message_received', from: 'Bob', msg_id: 7 }] }));
}
await sleep(2000);
ok(/\[Alice\] new message from Bob \(#7\)/.test(stdout),
  'and the re-primed stream delivers the wake it was armed for');

watcher.kill('SIGTERM');
await new Promise((r) => daemon.close(r));
rmSync(stateDir, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
