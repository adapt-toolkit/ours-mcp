// REQUIRED — proves the one thing a mock can never prove: does the REAL defaultSpawnWatch
// (Bun.spawn + incremental stream reading, plugin/ours-monitor.impl.mjs) actually deliver a line
// from a REAL, never-exiting `ours-mcp watch <identity>` process when a REAL message arrives,
// and does it keep draining stderr so the child never deadlocks on a full pipe? Both are
// runtime/OS-process properties, not model/LLM properties, so this test needs NO opencode
// server, NO model turn, NO billing/auth. It runs the REAL impl module under a REAL Bun runtime
// (via test/live-watch-driver.mjs, spawned as a child process) against a REAL isolated ours-mcp
// daemon — deterministic, fast, billing-independent.
//
// Skips gracefully if: ours-mcp is unavailable, or a real `bun` binary can't be obtained (tries
// the host's PATH first, then npm-installs `bun` into a throwaway prefix — skips if that fails,
// e.g. no network).
//
// Safety: every throwaway directory here comes from mktemp, bound to its own dedicated variable
// — never reused as HOME/a sensitive var and then rm -rf'd. Nothing here touches the real
// ~/.ours daemon.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = dirname(HERE);
const IMPL_PATH = join(PKG, 'plugin', 'ours-monitor.impl.mjs');
const DRIVER_PATH = join(HERE, 'live-watch-driver.mjs');

let BUN_BIN = null;
let OURS_MCP_AVAILABLE = false;
let SKIP_REASON = null;

before(() => {
  try {
    execFileSync('ours-mcp', ['--version'], { stdio: 'pipe' });
    OURS_MCP_AVAILABLE = true;
  } catch (err) {
    SKIP_REASON = `ours-mcp binary unavailable (${err.message}) — skipping`;
    return;
  }
  try {
    execFileSync('bun', ['--version'], { stdio: 'pipe' });
    BUN_BIN = 'bun';
    return;
  } catch {
    // fall through to a throwaway npm install of the `bun` launcher package
  }
  try {
    const setupDir = mkdtempSync(join(tmpdir(), 'bun-setup-'));
    execFileSync('npm', ['install', 'bun@latest', '--no-save', '--no-audit', '--no-fund'], {
      cwd: setupDir,
      stdio: 'pipe',
      timeout: 120_000,
    });
    const candidate = join(setupDir, 'node_modules', '.bin', 'bun');
    if (!existsSync(candidate)) throw new Error('bun installed but launcher not found at expected path');
    chmodSync(candidate, 0o755);
    BUN_BIN = candidate;
  } catch (err) {
    SKIP_REASON = `no real bun runtime available (${err.message}) — e2e-tier, skipping`;
  }
});

// --- minimal MCP stdio client (JSON-RPC 2.0, newline-delimited), inline so this file is fully
// self-contained and can be reviewed/run standalone. ---
function mcpClient(env) {
  // ours-mcp proxy's session-restore
  // self-recovers a prior identity binding keyed by the ambient CLAUDE_CODE_SESSION_ID env var,
  // which every proxy process spawned from this shell shares. A fresh random id per connection
  // means each one is a "new session" with nothing to restore, so sender/receiver never collide.
  const proc = spawn('ours-mcp', ['proxy'], {
    env: { ...process.env, ...env, CLAUDE_CODE_SESSION_ID: randomUUID() },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const rl = createInterface({ input: proc.stdout });
  const pending = new Map();
  let id = 0;
  rl.on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  function request(method, params) {
    const myId = ++id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(myId); reject(new Error(`mcp request ${method} timed out`)); }, 20_000);
      pending.set(myId, (msg) => { clearTimeout(timer); resolve(msg); });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
    });
  }
  async function callTool(name, args) {
    const res = await request('tools/call', { name, arguments: args });
    if (res.error) throw new Error(`${name} failed: ${JSON.stringify(res.error)}`);
    return res.result;
  }
  async function init() {
    await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'ours-monitor-live-watch-test', version: '0.0.1' } });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  }
  return { init, callTool, close: () => proc.kill() };
}

async function waitFor(fn, { timeoutMs = 15_000, intervalMs = 300 } = {}) {
  const start = Date.now();
  for (;;) {
    const result = fn();
    if (result) return result;
    if (Date.now() - start > timeoutMs) return null;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

test('REQUIRED — the real Bun.spawn watch delivers a TICK line for a real inbound message, and stays alive (stderr drained, no deadlock)', async (t) => {
  if (!OURS_MCP_AVAILABLE || !BUN_BIN) return t.skip(SKIP_REASON ?? 'prerequisites unavailable');

  const suffix = randomUUID().slice(0, 8);
  const senderIdentity = `livewatch-sender-${suffix}`;
  const receiverIdentity = `livewatch-receiver-${suffix}`;

  const daemonSandbox = mkdtempSync(join(tmpdir(), 'ours-livewatch-daemon-'));
  const daemonStateDir = join(daemonSandbox, 'state');
  const daemonPort = String(31000 + Math.floor(Math.random() * 3000));
  const daemonEnv = { OURS_STATE_DIR: daemonStateDir, OURS_PORT: daemonPort };

  execFileSync('ours-mcp', ['start'], { env: { ...process.env, ...daemonEnv }, stdio: 'pipe', timeout: 20_000 });
  t.after(() => {
    try { execFileSync('ours-mcp', ['stop'], { env: { ...process.env, ...daemonEnv }, stdio: 'pipe', timeout: 20_000 }); } catch { /* best-effort */ }
  });

  const receiverSetup = mcpClient(daemonEnv);
  await receiverSetup.init();
  await receiverSetup.callTool('create_identity', { name: receiverIdentity });
  receiverSetup.close();

  const sender = mcpClient(daemonEnv);
  await sender.init();
  await sender.callTool('create_identity', { name: senderIdentity });
  t.after(() => sender.close());
  // Guard against ours-mcp proxy's own session-restore self-recovering a stale binding — bind
  // explicitly right before sending.
  await sender.callTool('choose_identity', { name: senderIdentity });

  // --- spawn the REAL driver under a REAL bun runtime, importing the REAL impl module ---
  const driver = spawn(BUN_BIN, [DRIVER_PATH, IMPL_PATH, receiverIdentity], {
    env: { ...process.env, ...daemonEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const driverLines = [];
  const rl = createInterface({ input: driver.stdout });
  rl.on('line', (line) => driverLines.push(line));
  const driverStderr = [];
  driver.stderr.on('data', (d) => driverStderr.push(d.toString()));
  t.after(() => driver.kill());

  const spawned = await waitFor(() => driverLines.some((l) => l.startsWith('SPAWNED pid=')), { timeoutMs: 10_000 });
  assert.ok(spawned, `expected the driver to report a spawned pid within 10s. stderr so far: ${driverStderr.join('')}`);
  // `ours-mcp watch` needs a brief moment after spawning to establish its subscription to the
  // daemon's notification stream — sending immediately after the pid is known (no gap at all)
  // can race ahead of that subscription. A short settle delay here is not masking the property
  // under test (line delivery once subscribed); it mirrors how a real caller would naturally
  // have some gap between arming and a message actually arriving.
  await new Promise((r) => setTimeout(r, 2000));

  // the real wake trigger: an ACTUAL message from a second identity, over the real daemon
  const pingText = `livewatch ping ${suffix}`;
  const sendRes = await sender.callTool('send_message', { contact: receiverIdentity, text: pingText });
  assert.equal(sendRes.isError, false, `send_message should succeed: ${JSON.stringify(sendRes)}`);

  const tickLine = await waitFor(() => driverLines.find((l) => l.startsWith('LINE: ') && l.includes(senderIdentity)), { timeoutMs: 20_000 });
  assert.ok(
    tickLine,
    `expected a real LINE: tick mentioning ${senderIdentity} within 20s of a real send_message — a missing tick would ` +
      `mean the watch never yields for a real long-running process. Driver output so far:\n${driverLines.join('\n')}`,
  );

  // REQUIRED — the driver process must still be ALIVE after receiving the tick: if stderr
  // weren't drained and had backed up, the child would already be deadlocked (blocked on its
  // next stderr write) by this point, and/or the driver would have crashed.
  assert.equal(driver.exitCode, null, 'the driver process (and the real ours-mcp watch child inside it) must still be running, not deadlocked or crashed');
  assert.equal(driver.killed, false);
});
