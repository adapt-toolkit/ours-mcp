// daemon-restart-resume — connector silently re-binds after daemon restart.
//
// Scenario: the connector is ALIVE throughout. The daemon is killed and
// restarted on the same port + state dir (simulating an upgrade/crash).
// The connector's reconnect() fires, replays initialize + choose_identity
// (the silent safety-net replay in proxy.ts), and re-binds against the fresh
// daemon — WITHOUT any explicit choose_identity from the test. A per-container
// tool call then succeeds, proving seamless resume.
//
// Self-contained: spawns the BUILT daemon (dist/cli.js serve) and the built
// connector (dist/cli.js proxy over stdio). Run after `npm run build`.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---- tiny harness -----------------------------------------------------------
let pass = 0;
let fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else       { fail++; console.log('  ✗ FAIL:', msg); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
  });
}

async function waitForVersion(port, maxMs = 20_000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try { const r = await fetch(`http://127.0.0.1:${port}/version`); if (r.ok) return; } catch { /* not yet */ }
    await sleep(250);
  }
  throw new Error('daemon did not come up on :' + port);
}

// The inverse boundary: the daemon is REALLY gone, not merely signalled. SIGKILL
// is asynchronous, so "killed" and "the port is free" are different moments, and
// step (3a) depends on the second one.
async function waitForPortClosed(port, maxMs = 20_000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const open = await new Promise((res) => {
      const s = connect({ host: '127.0.0.1', port });
      const done = (v) => { try { s.destroy(); } catch { /* ignore */ } res(v); };
      s.once('connect', () => done(true));
      s.once('error', () => done(false));
      setTimeout(() => done(false), 500);
    });
    if (!open) return;
    await sleep(100);
  }
  throw new Error('daemon still listening on :' + port);
}

// The connector narrates its own upstream lifecycle on stderr. Waiting for one of
// those lines is an OBSERVABLE BOUNDARY — unlike a sleep, it cannot be outrun by a
// slow machine, and when it times out it says what the connector did instead.
function proxyLog(transport) {
  const lines = [];
  const waiters = [];
  transport.stderr?.on('data', (chunk) => {
    for (const raw of String(chunk).split('\n')) {
      const ln = raw.trim();
      if (!ln) continue;
      lines.push(ln);
      for (const w of [...waiters]) {
        if (w.re.test(ln)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(ln); }
      }
    }
  });
  return {
    lines,
    saw: (re) => lines.some((ln) => re.test(ln)),
    async wait(re, maxMs, what) {
      const hit = lines.find((ln) => re.test(ln));
      if (hit) return hit;
      return new Promise((resolve, reject) => {
        const w = { re, resolve };
        waiters.push(w);
        setTimeout(() => {
          if (!waiters.includes(w)) return;
          waiters.splice(waiters.indexOf(w), 1);
          reject(new Error(`timed out waiting for ${what}. Connector said:\n  ${lines.slice(-15).join('\n  ')}`));
        }, maxMs).unref?.();
      });
    },
  };
}

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'dist', 'cli.js');
const STATE = mkdtempSync(join(tmpdir(), 'a2a-drr-'));
const BROKER = 'ws://127.0.0.1:59997/nobroker'; // unreachable on purpose
const PORT = await freePort();

const baseEnv = () => ({
  ...process.env,
  OURS_PORT: String(PORT),
  OURS_STATE_DIR: STATE,
  OURS_BROKER_URL: BROKER,
});

mkdirSync(STATE, { recursive: true });
console.log('daemon-restart-resume\n');

let daemon1;
let proxy;
try {
  // 1. Start the first daemon.
  daemon1 = spawn('node', [CLI, 'serve'], { env: baseEnv(), stdio: 'ignore', detached: true });
  await waitForVersion(PORT);

  // 2. Connect a proxy (stdio connector) with a stable CLAUDE_CODE_SESSION_ID.
  const transport = new StdioClientTransport({
    command: 'node',
    args: [CLI, 'proxy'],
    env: {
      ...baseEnv(),
      CLAUDE_CODE_SESSION_ID: 'drr-stable-session',
      // Bound the pathological path in (3a). The normal path fails back in
      // milliseconds (the upstream send cannot even leave the machine); this only
      // caps the case where the connector had already dropped the upstream on its
      // own, which parks the frame until the watchdog. Not a retry — the watchdog
      // is the same fail-back, just reached the slow way.
      OURS_REQUEST_TIMEOUT_MS: '15000',
    },
    stderr: 'pipe',
  });
  proxy = new Client({ name: 'drr-test', version: '0.0.0' });
  await proxy.connect(transport);
  const log = proxyLog(transport);

  const call = (name, args = {}) => proxy.callTool({ name, arguments: args });
  const isOk = (r) => !r.isError;
  const text = (r) => (r.content ?? []).map((c) => c.text ?? '').join('\n');

  // 3. Bind an identity.
  const created = await call('create_identity', { name: 'Dora', expose_local: false });
  assert(isOk(created), '(1) create_identity Dora succeeds (also binds it)');

  // 4. Confirm a per-container call works on the FIRST daemon.
  const gm1 = await call('get_messages');
  assert(isOk(gm1) && !/No identity bound/i.test(text(gm1)), '(2) get_messages works on first daemon');

  // 5. Kill the first daemon, and wait for the PORT to actually close — not for a
  //    guessed interval. SIGKILL is asynchronous; "signalled" and "gone" are
  //    different moments and (3a) depends on the second one.
  try { process.kill(-daemon1.pid, 'SIGKILL'); } catch { /* already gone */ }
  await waitForPortClosed(PORT);

  // 6. THE FIRST CALL AFTER THE UPSTREAM DIES FAILS BACK, AND THAT IS THE INTENDED
  //    CONTRACT — not a regression.
  //    This test used to make ONE call here and assert it succeeded. That only
  //    worked because the proxy re-queued the FAILED REQUEST FRAME and replayed
  //    it after reconnecting — i.e. the test was encoding the blind replay as
  //    the contract. That replay is exactly the defect we removed: `send()` also
  //    rejects when the POST was ACCEPTED and the tool already ran, so replaying
  //    a request could execute it twice — and get_messages marks mail read and
  //    delivers exactly once, so the second run consumes messages that reach
  //    nobody. A hang silently converted into data loss.
  //    Requests are therefore no longer replayed; they fail back and the caller
  //    decides whether repeating is safe. Only the caller knows that.
  //
  //    WHY THIS RUNS BEFORE THE SECOND DAEMON EXISTS — do not "simplify" it back.
  //    A fail-back only happens for a request that is ALREADY IN FLIGHT when the
  //    connector notices the upstream is gone: the drop handler fails back exactly
  //    the pending requests belonging to the dropped transport. The connector also
  //    notices on its OWN, without any request, once its notification stream
  //    exhausts its reconnection budget (~13s) — and then it silently re-binds with
  //    nothing pending to fail back.
  //    So "does the caller get a fail-back?" is not a property of the restart; it is
  //    a race between the test's call and the connector's own detection. The old
  //    version made that call AFTER starting daemon 2 and AFTER a fixed sleep(2000)
  //    that followed a VARIABLE-duration daemon startup — so on a loaded machine the
  //    connector won, the pending map was empty, and the call legitimately
  //    succeeded. That is the flake: a real race in the test, not in the daemon.
  //    Issuing the call while NOTHING is listening removes the race instead of
  //    outrunning it. There is no daemon that could answer, so the only reachable
  //    outcomes are the immediate fail-back (upstream send failed) or, if the
  //    connector happened to drop first, the same fail-back via the watchdog. The
  //    request can never succeed, so the assertion can never flake.
  //    WHAT THE OUTCOME ACTUALLY WAS IS RECORDED, not just whether it matched: the
  //    call SUCCEEDED (contract broken), it threw the WRONG error (contract broken
  //    differently), or it threw the right one. The message names which.
  let firstOutcome;
  try {
    const r = await call('get_messages');
    firstOutcome = `SUCCEEDED (no fail-back): ${text(r).slice(0, 120)}`;
  } catch (e) {
    const msg = String(e?.message ?? e);
    firstOutcome = /NOT retried/i.test(msg) ? null : `threw the WRONG error: ${msg.slice(0, 160)}`;
  }
  assert(firstOutcome === null,
    '(3a) a request in flight when the upstream dies FAILS BACK instead of being silently replayed — ' +
    `the caller is told, and told it was not retried${firstOutcome ? ` [actual: ${firstOutcome}]` : ''}`);

  // 7. Start a SECOND daemon on the same port + state dir.
  const daemon2 = spawn('node', [CLI, 'serve'], { env: baseEnv(), stdio: 'ignore', detached: true });
  try {
    await waitForVersion(PORT);

    // 8. Wait for the connector to say it re-bound, rather than sleeping and hoping.
    //    Its reconnect loop replays initialize + choose_identity as SYNTHETIC frames;
    //    "upstream reconnected (re-bound …)" is the moment that finished. This is the
    //    observable lifecycle boundary the old sleep(2000) was standing in for.
    await log.wait(/upstream reconnected/, 60_000, 'the connector to re-bind against the new daemon');

    // 9. The retry succeeds WITHOUT any explicit choose_identity from the test,
    //    which is what proves the silent re-bind actually happened.
    //    NOTE this separates two things the old single-call assertion conflated:
    //    (3a) proves the USER'S REQUEST was not replayed; (3b) proves the
    //    HANDSHAKE + BINDING were. Previously a pass could have meant either.
    const gm2 = await call('get_messages');
    assert(isOk(gm2) && !/No identity bound/i.test(text(gm2)), '(3b) the RETRY succeeds on the SECOND daemon WITHOUT explicit choose_identity — silent replay re-bound');

    // 10. The re-bind is the connector's own, not a replay of the user's request:
    //     it must have re-sent choose_identity, and must NOT have re-sent the
    //     get_messages that failed back — replaying it would consume mail twice.
    assert(log.saw(/re-bound "Dora"/), '(3c) the connector re-bound the identity itself (synthetic choose_identity replay)');
    const failedBack = log.lines.filter((ln) => /FAILING BACK request/.test(ln));
    assert(failedBack.length === 1,
      `(3d) exactly ONE request was failed back and none was replayed (saw ${failedBack.length}: ${failedBack.join(' | ') || 'none'})`);

    // 11. Also verify current_identity reflects Dora.
    const ci = await call('current_identity');
    assert(isOk(ci) && /Dora/.test(text(ci)), '(4) current_identity is still Dora after daemon restart');
  } finally {
    try { process.kill(-daemon2.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
} finally {
  try { if (daemon1?.pid) process.kill(-daemon1.pid, 'SIGKILL'); } catch { /* already gone */ }
  try { await proxy?.close?.(); } catch { /* best effort */ }
  try { rmSync(STATE, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log(`\n${pass}/${pass + fail} passed${fail ? ` (${fail} FAILED)` : ''}`);
process.exit(fail === 0 ? 0 : 1);
