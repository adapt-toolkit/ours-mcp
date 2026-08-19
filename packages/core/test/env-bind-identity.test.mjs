// OURS_BIND_IDENTITY — can a SUPERVISOR say which identity a session starts on,
// without the MODEL performing the bind?
//
// A fleet role's first boot bound nothing. The briefing told the agent to call
// choose_identity itself — a deterministic step handed to a non-deterministic
// actor, which pays a round trip, can get the name wrong, and on a wake-up where
// those instructions have fallen out of context has nothing naming the identity
// at all. The supervisor already knows the name; this is the input that lets it
// say so.
//
// ----- WHAT MUST NOT REGRESS -----------------------------------------------
// The seeded bind is PLAIN. It rides assertRestoreBinding()'s existing synthetic
// choose_identity with force:false, so it inherits that path's refusal: a LIVE
// session holding the identity is never evicted. Section 4 is the one that
// matters — it is the reason this input is safe to hand a supervisor at all. If
// it ever starts passing for the wrong reason, an environment variable has become
// a remote-eviction primitive.
//
// ----- WHY EVERY SESSION HERE OWNS A SEPARATE `sleep` CHILD -----------------
// A lease is reclaimable only when its CLIENT's pid is dead (the client is the
// harness, not the proxy — the proxy reports it as x-ours-client-pid). Every
// proxy in one test file would otherwise inherit the same client pid, this test
// process's, which stays alive for the whole run — so "the previous session went
// away" would be inexpressible, and section 2 could only be made to pass by
// forcing, which is the exact thing under test. Each session gets a real pid this
// test can kill, which is the shape of an idle harness that died. Section 4
// deliberately does the opposite and keeps its child ALIVE.
//
// Self-contained: spawns the BUILT daemon (dist/cli.js serve) on an isolated temp
// state dir and an ephemeral port, with no broker (the binding path is local).
// Run after `npm run build`:
//   npm --workspace @ours.network/mcp test
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
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
const STATE = mkdtempSync(join(tmpdir(), 'a2a-core-envbind-'));
const BROKER = 'ws://127.0.0.1:59997/nobroker'; // unreachable on purpose — binding is local
const BIND_MS = 1500; // the seeded bind rides Claude's first `initialized`

const baseEnv = () => ({
  ...process.env,
  // The variable under test is set per session below and NOWHERE else. An
  // ours-fleet-managed host exports it for its own agents, and inheriting that
  // would silently seed the sections that must start from nothing.
  OURS_BIND_IDENTITY: undefined,
  OURS_PORT: String(PORT),
  OURS_STATE_DIR: STATE,
  OURS_BROKER_URL: BROKER,
});

let PORT;

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

/** A live process whose pid stands in for a harness. `end()` makes it dead. */
const clients = [];
function fakeClient() {
  const child = spawn('sleep', ['300'], { stdio: 'ignore' });
  // `exited` must be latched: 'exit' fires ONCE, so a second end() awaiting it
  // would wait forever — and the cleanup in `finally` ends every client again.
  let exited = false;
  child.once('exit', () => { exited = true; });
  const c = {
    pid: child.pid,
    end: async () => {
      if (exited) return;
      child.kill('SIGKILL');
      await new Promise((r) => (exited ? r() : child.once('exit', r)));
      await sleep(200); // let the daemon see a dead pid on the next contention
    },
  };
  clients.push(c);
  return c;
}

// sessionId null => no CLAUDE_CODE_SESSION_ID at all (lease token falls back to
// `client:<pid>`), which is what a non-Claude supervisor actually looks like.
async function connectProxy(label, sessionId, clientPid, extra = {}) {
  const env = { ...baseEnv(), OURS_CLIENT_PID: String(clientPid), ...extra };
  if (sessionId) env.CLAUDE_CODE_SESSION_ID = sessionId;
  else delete env.CLAUDE_CODE_SESSION_ID;
  const transport = new StdioClientTransport({
    command: 'node',
    args: [CLI, 'proxy'],
    env,
    stderr: 'ignore',
  });
  const client = new Client({ name: `envbind-${label}`, version: '0.0.0' });
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
  console.log('OURS_BIND_IDENTITY — supervisor-named startup binding\n');

  // ── 1. two identities exist, created by an earlier session that is now gone ─
  // Run with the restore opt-out so this setup session leaves no record behind to
  // confuse the sections below. create_identity binds what it creates, so Bo ends
  // up holding this session's lease and Ana is released by the switch; killing the
  // client frees Bo too.
  {
    const c = fakeClient();
    const s = await connectProxy('setup', 'sess-setup', c.pid, { OURS_NO_AUTORESTORE: '1' });
    assert((await call(s.client, 'create_identity', { name: 'Ana', expose_local: false })).ok, '(1) setup: create Ana');
    assert(
      (await call(s.client, 'create_identity', { name: 'Bo', expose_local: false })).ok,
      '(1) setup: create Bo (switches this session\'s binding to Bo, releasing Ana)',
    );
    await sleep(300);
    await s.transport.close();
    await sleep(400);
    await c.end(); // the lease is not released on close — only a dead client frees it
  }

  // ── 2. a NEW session, a NEW lease token, and no bind call at all ────────────
  // THE POINT OF THE FEATURE. Fails before the change: the proxy has no reason to
  // bind anything on a boot with no restore record, so this session stays unbound.
  {
    const c = fakeClient();
    const p = await connectProxy('seeded', 'sess-seeded', c.pid, { OURS_BIND_IDENTITY: 'Ana' });
    await sleep(BIND_MS);
    assert((await boundIdentity(p.client)) === 'Ana',
      '(2) OURS_BIND_IDENTITY binds at startup with NO tool call from the model');
    const gm = await call(p.client, 'get_messages');
    assert(gm.ok && !/No identity bound/i.test(gm.text), '(2) and the binding is real — get_messages works');
    await p.transport.close();
    await sleep(400);
    await c.end();
  }

  // ── 3. a name that does not exist must not stop the session ────────────────
  // A role whose identity has not been created yet has to boot and reach the step
  // in its own instructions that creates it. Unbound is the right outcome; a dead
  // connector is not. This is main's existing "no such identity" path — the seeded
  // bind is refused exactly like a self-recovery against a missing record.
  {
    const c = fakeClient();
    const p = await connectProxy('missing', 'sess-missing', c.pid, { OURS_BIND_IDENTITY: 'Nobody' });
    await sleep(BIND_MS);
    assert((await boundIdentity(p.client)) === null,
      '(3) an unknown identity leaves the session UNBOUND rather than failing to start');
    assert(/Ana/.test((await call(p.client, 'list_identities')).text),
      '(3) and the session is otherwise fully usable');
    await p.transport.close();
    await sleep(400);
    await c.end();
  }

  // ── 4. THE CONTROL: a live holder is never evicted ─────────────────────────
  // Both clients stay ALIVE for this section, so the holder's lease is genuinely
  // unreclaimable and the intruder's plain bind has to be refused on the merits.
  {
    const holderClient = fakeClient();
    const holder = await connectProxy('holder', 'sess-holder', holderClient.pid, { OURS_BIND_IDENTITY: 'Ana' });
    await sleep(BIND_MS);
    assert((await boundIdentity(holder.client)) === 'Ana',
      '(4) a holder session is bound to Ana, and its client stays alive');

    const intruderClient = fakeClient();
    const intruder = await connectProxy('intruder', 'sess-intruder', intruderClient.pid, { OURS_BIND_IDENTITY: 'Ana' });
    await sleep(BIND_MS);
    assert((await boundIdentity(intruder.client)) === null,
      '(4) a seeded bind against a LIVE holder is DECLINED, not forced');
    assert((await boundIdentity(holder.client)) === 'Ana',
      '(4) and the live holder is STILL bound — the seed cannot evict a live session');

    await intruder.transport.close();
    await holder.transport.close();
    await sleep(400);
    await intruderClient.end();
    await holderClient.end();
  }

  // ── 5. no CLAUDE_CODE_SESSION_ID, and the restore opt-out set ──────────────
  // main-specific. The seed shares a field with session-restore but not its
  // preconditions: a supervisor is not Claude and need not set a session id, and
  // OURS_NO_AUTORESTORE is about persisting a RECORD — there is nothing to persist
  // here, so it must not disable the seed.
  {
    const c = fakeClient();
    const p = await connectProxy('nosession', null, c.pid, {
      OURS_BIND_IDENTITY: 'Ana',
      OURS_NO_AUTORESTORE: '1',
    });
    await sleep(BIND_MS);
    assert((await boundIdentity(p.client)) === 'Ana',
      '(5) binds with no CLAUDE_CODE_SESSION_ID and OURS_NO_AUTORESTORE=1 set');
    await p.transport.close();
    await sleep(400);
    await c.end();
  }

  // ── 6. precedence: this session's own restore record beats the supervisor ───
  // main-specific, and the deliberate choice. The record is written only after an
  // OBSERVED successful bind by this exact session, so it is the more current
  // fact; an agent that switched identity mid-session must not be dragged back to
  // its launcher's name on every wake-up while still believing it is the identity
  // it chose.
  {
    const c1 = fakeClient();
    const p1 = await connectProxy('prec-1', 'sess-prec', c1.pid);
    assert((await call(p1.client, 'choose_identity', { name: 'Bo' })).ok,
      '(6) sess-prec binds Bo itself, writing a restore record');
    await sleep(300);
    await p1.transport.close();
    await sleep(400);
    await c1.end();

    const c2 = fakeClient();
    const p2 = await connectProxy('prec-2', 'sess-prec', c2.pid, { OURS_BIND_IDENTITY: 'Ana' });
    await sleep(BIND_MS);
    assert((await boundIdentity(p2.client)) === 'Bo',
      '(6) the record (Bo) wins over OURS_BIND_IDENTITY (Ana) — the seed is the weaker source');
    await p2.transport.close();
    await sleep(400);
    await c2.end();
  }
} finally {
  for (const c of clients) await c.end().catch(() => {});
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
