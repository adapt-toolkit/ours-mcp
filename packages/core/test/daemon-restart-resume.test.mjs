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
import { createServer } from 'node:net';
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
    env: { ...baseEnv(), CLAUDE_CODE_SESSION_ID: 'drr-stable-session' },
    stderr: 'ignore',
  });
  proxy = new Client({ name: 'drr-test', version: '0.0.0' });
  await proxy.connect(transport);

  const call = (name, args = {}) => proxy.callTool({ name, arguments: args });
  const isOk = (r) => !r.isError;
  const text = (r) => (r.content ?? []).map((c) => c.text ?? '').join('\n');

  // 3. Bind an identity.
  const created = await call('create_identity', { name: 'Dora', expose_local: false });
  assert(isOk(created), '(1) create_identity Dora succeeds (also binds it)');

  // 4. Confirm a per-container call works on the FIRST daemon.
  const gm1 = await call('get_messages');
  assert(isOk(gm1) && !/No identity bound/i.test(text(gm1)), '(2) get_messages works on first daemon');

  // 5. Kill the first daemon.
  try { process.kill(-daemon1.pid, 'SIGKILL'); } catch { /* already gone */ }
  await sleep(600);

  // 6. Start a SECOND daemon on the same port + state dir.
  const daemon2 = spawn('node', [CLI, 'serve'], { env: baseEnv(), stdio: 'ignore', detached: true });
  try {
    await waitForVersion(PORT);

    // 7. Give the connector's reconnect() loop time to fire and replay.
    //    The proxy detects the dead upstream on the next POST attempt, drops, and
    //    runs reconnect() which replays initialize + choose_identity (silent rebind).
    //    We trigger the drop by calling a tool (which will fail once, then recover).
    await sleep(2000);

    // 8. Without any explicit choose_identity from the test, call a per-container
    //    tool and assert it succeeds — proving the silent replay re-bound.
    const gm2 = await call('get_messages');
    assert(isOk(gm2) && !/No identity bound/i.test(text(gm2)), '(3) get_messages succeeds on SECOND daemon WITHOUT explicit choose_identity — silent replay re-bound');

    // 9. Also verify current_identity reflects Dora.
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
