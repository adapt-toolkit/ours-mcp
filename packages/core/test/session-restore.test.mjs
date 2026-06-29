// A2A-1c — session-keyed self-recovery of the bound identity.
//
// Regression suite for the per-wake binding drop: a cold Claude wake-up spawns a
// fresh proxy process, which loses the in-memory boundIdentity, so the agent —
// still believing it is bound — gets "No identity bound" on its next call. The
// proxy persists a tiny {identity} record keyed by CLAUDE_CODE_SESSION_ID and
// self-recovers it on the next boot via a PLAIN (no-force) choose_identity.
//
// Covers: self-recovery, no cross-session inheritance, first-boot-unbound,
// latest-not-superseded, opt-out (OURS_NO_AUTORESTORE), TTL expiry,
// fail-closed vs a live holder (no auto-evict), and at-rest 0700/0600 perms.
//
// Self-contained: spawns the BUILT daemon (dist/cli.js serve) on an isolated
// temp state dir and an ephemeral port, with no broker (the binding path is
// local). Run after `npm run build`:
//   npm --workspace @ours.network/mcp test
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, existsSync, utimesSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---- tiny harness ----------------------------------------------------------
let pass = 0;
let fail = 0;
function assert(cond, msg) {
  if (cond) {
    pass++;
    console.log('  ✓', msg);
  } else {
    fail++;
    console.log('  ✗ FAIL:', msg);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'dist', 'cli.js');
const STATE = mkdtempSync(join(tmpdir(), 'a2a-core-restore-'));
const RESTORE_DIR = join(STATE, 'session-restore');
const BROKER = 'ws://127.0.0.1:59998/nobroker'; // unreachable on purpose — binding is local
const RECOVER_MS = 1500;
let PORT;

const baseEnv = () => ({
  ...process.env,
  OURS_PORT: String(PORT),
  OURS_STATE_DIR: STATE,
  OURS_BROKER_URL: BROKER,
});

async function waitDaemon() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/state-dir`);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error('daemon did not come up on :' + PORT);
}

async function connectProxy(label, sessionId, extra = {}) {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [CLI, 'proxy'],
    env: { ...baseEnv(), CLAUDE_CODE_SESSION_ID: sessionId, ...extra },
    stderr: 'ignore',
  });
  const client = new Client({ name: `t6-${label}`, version: '0.0.0' });
  await client.connect(transport);
  return { client, transport };
}

async function call(client, name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content ?? []).map((c) => c.text ?? '').join('\n');
  return { ok: !res.isError, text };
}

async function boundIdentity(client) {
  const ci = await call(client, 'current_identity');
  if (/no identity bound|not bound/i.test(ci.text)) return null;
  const m = ci.text.match(/Bound to "([^"]+)"/);
  return m ? m[1] : null;
}

let daemon;
try {
  PORT = await freePort();
  rmSync(STATE, { recursive: true, force: true });
  mkdirSync(STATE, { recursive: true });
  daemon = spawn('node', [CLI, 'serve'], {
    env: { ...baseEnv(), OURS_GC_INTERVAL_MS: '3600000' },
    stdio: 'ignore',
    detached: true,
  });
  await waitDaemon();
  console.log('A2A-1c — session-keyed self-recovery\n');

  // setup: two identities; create_identity binds the just-created one, so RY is
  // the live binding for the setup session (run with opt-out so it writes no record).
  {
    const s = await connectProxy('setup', 'setup-session', { OURS_NO_AUTORESTORE: '1' });
    assert((await call(s.client, 'create_identity', { name: 'RX', expose_local: false })).ok, 'setup: create RX');
    assert(
      (await call(s.client, 'create_identity', { name: 'RY', expose_local: false })).ok,
      'setup: create RY (switches binding to RY)',
    );
    await s.transport.close();
    await sleep(500);
  }

  // (a) same session id self-recovers its bound identity on a fresh proxy boot.
  {
    const p1 = await connectProxy('a1', 'sess-A');
    assert((await call(p1.client, 'choose_identity', { name: 'RX' })).ok, '(a) p1 binds RX');
    await sleep(300);
    await p1.transport.close();
    await sleep(500);
    const p2 = await connectProxy('a2', 'sess-A');
    await sleep(RECOVER_MS);
    assert((await boundIdentity(p2.client)) === 'RX', '(a) p2 (same session id) SELF-RECOVERS RX without choose_identity');
    const gm = await call(p2.client, 'get_messages');
    assert(gm.ok && !/No identity bound/i.test(gm.text), '(a) p2 get_messages works');
    await p2.transport.close();
    await sleep(400);
  }

  // (c) a different session id never inherits another session's binding.
  {
    const p = await connectProxy('c', 'sess-C-never-bound');
    await sleep(RECOVER_MS);
    assert((await boundIdentity(p.client)) === null, '(c) different session id does NOT inherit');
    await p.transport.close();
    await sleep(400);
  }

  // (d) a true first-ever boot with no record stays unbound (no auto-bind).
  {
    const p = await connectProxy('d', 'sess-D-fresh');
    await sleep(RECOVER_MS);
    assert((await boundIdentity(p.client)) === null, '(d) first-ever boot with no record stays UNBOUND');
    await p.transport.close();
    await sleep(400);
  }

  // (e) a switch overwrites the record — recovery yields the LATEST, not the superseded, identity.
  // force=true because the prior section (a) left RX held with a live client pid (test runner);
  // with client-pid liveness the daemon correctly requires force to displace a live holder.
  {
    const p1 = await connectProxy('e1', 'sess-E');
    assert((await call(p1.client, 'choose_identity', { name: 'RX', force: true })).ok, '(e) p1 binds RX');
    await sleep(200);
    // force=true because (a) left RY held with a live client pid (test runner).
    assert((await call(p1.client, 'choose_identity', { name: 'RY', force: true })).ok, '(e) p1 switches to RY');
    await sleep(300);
    await p1.transport.close();
    await sleep(500);
    const p2 = await connectProxy('e2', 'sess-E');
    await sleep(RECOVER_MS);
    assert((await boundIdentity(p2.client)) === 'RY', '(e) recovers the LATEST identity (RY), not superseded RX');
    await p2.transport.close();
    await sleep(400);
  }

  // (f) opt-out (OURS_NO_AUTORESTORE=1): no record written, and no self-recovery after a
  // daemon restart (where in-memory leases are cleared and only the disk record matters).
  // With stable-token liveness, a waking proxy on a RUNNING daemon re-attaches via the lease
  // regardless of opt-out — opt-out only suppresses the disk record (the daemon-restart path).
  {
    const p1 = await connectProxy('f1', 'sess-F', { OURS_NO_AUTORESTORE: '1' });
    // RX was released by (e)'s switch to RY, so a plain bind suffices.
    assert((await call(p1.client, 'choose_identity', { name: 'RX' })).ok, '(f) p1 binds RX with opt-out');
    await sleep(300);
    await p1.transport.close();
    await sleep(400);
    assert(!existsSync(join(RESTORE_DIR, 'sess-F.json')), '(f) opt-out: NO restore record written');
    // Restart daemon to clear in-memory leases; only the (absent) disk record matters now.
    if (daemon?.pid) try { process.kill(-daemon.pid, 'SIGKILL'); } catch { /* already gone */ }
    await sleep(400);
    daemon = spawn('node', [CLI, 'serve'], {
      env: { ...baseEnv(), OURS_GC_INTERVAL_MS: '3600000' },
      stdio: 'ignore',
      detached: true,
    });
    await waitDaemon();
    const p2 = await connectProxy('f2', 'sess-F');
    await sleep(RECOVER_MS);
    assert((await boundIdentity(p2.client)) === null, '(f) opt-out session does not self-recover after daemon restart');
    await p2.transport.close();
    await sleep(400);
  }

  // (g) a record past the TTL (default 7d) is never self-recovered after a daemon restart.
  // With stable-token liveness, a waking proxy re-attaches via the in-memory lease (bypass restore).
  // The TTL matters when the daemon itself is restarted (clearing in-memory leases) and the proxy
  // tries to self-recover: an expired record must not auto-bind.
  // The daemon was restarted in (f), so RX has no lease in the current daemon; no force needed.
  {
    const p1 = await connectProxy('g1', 'sess-G');
    assert((await call(p1.client, 'choose_identity', { name: 'RX' })).ok, '(g) p1 binds RX');
    await sleep(300);
    await p1.transport.close();
    await sleep(400);
    const recF = join(RESTORE_DIR, 'sess-G.json');
    assert(existsSync(recF), '(g) record written');
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    utimesSync(recF, old, old);
    // Restart the daemon to clear in-memory leases; now the restore record is the only source.
    if (daemon?.pid) try { process.kill(-daemon.pid, 'SIGKILL'); } catch { /* already gone */ }
    await sleep(400);
    daemon = spawn('node', [CLI, 'serve'], {
      env: { ...baseEnv(), OURS_GC_INTERVAL_MS: '3600000' },
      stdio: 'ignore',
      detached: true,
    });
    await waitDaemon();
    const p2 = await connectProxy('g2', 'sess-G');
    await sleep(RECOVER_MS);
    assert((await boundIdentity(p2.client)) === null, '(g) record past TTL is NOT self-recovered (even after daemon restart)');
    await p2.transport.close();
    await sleep(400);
  }

  // (h) fail-closed: a waking session must NOT evict a genuinely live holder (plain bind, no force).
  // (g) restarted the daemon, so RX has no lease in the current daemon — no force needed for pb.
  {
    const pb = await connectProxy('h-record', 'sess-H');
    assert(
      (await call(pb.client, 'choose_identity', { name: 'RX' })).ok,
      '(h) sess-H binds RX (writes record), then releases',
    );
    await sleep(300);
    await pb.transport.close();
    await sleep(500);
    const live = await connectProxy('h-live', 'sess-H-other');
    // force=true because sess-H's lease has a live client pid (test runner); this models the
    // real scenario where a different Claude session explicitly takes over the identity.
    assert((await call(live.client, 'choose_identity', { name: 'RX', force: true })).ok, '(h) a live session now holds RX');
    await sleep(300);
    const pb2 = await connectProxy('h-wake', 'sess-H');
    await sleep(RECOVER_MS);
    assert((await boundIdentity(pb2.client)) === null, '(h) FAIL-CLOSED: does NOT evict the live holder');
    assert((await boundIdentity(live.client)) === 'RX', '(h) the live holder KEEPS RX (no auto-eviction)');
    await pb2.transport.close();
    await live.transport.close();
    await sleep(400);
  }

  // (i) at-rest perms: restore dir 0700, record 0600.
  {
    assert((statSync(RESTORE_DIR).mode & 0o777) === 0o700, '(i) session-restore dir is 0700');
    const rec = join(RESTORE_DIR, 'sess-A.json');
    assert(existsSync(rec) && (statSync(rec).mode & 0o777) === 0o600, '(i) restore record is 0600');
  }

  console.log(`\n(restore dir: ${existsSync(RESTORE_DIR) ? readdirSync(RESTORE_DIR).join(', ') : '(none)'})`);
} finally {
  try {
    if (daemon?.pid) process.kill(-daemon.pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
  try {
    rmSync(STATE, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

console.log(`\n${pass}/${pass + fail} passed${fail ? ` (${fail} FAILED)` : ''}`);
process.exit(fail === 0 ? 0 : 1);
