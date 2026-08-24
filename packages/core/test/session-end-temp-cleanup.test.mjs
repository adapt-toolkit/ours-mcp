// Normal harness SessionEnd -> ours-mcp session-end -> MCP DELETE.
// Proves the shipped proxy/CLI lease-token seam performs deterministic cleanup
// for every temporary role owned by the session, including one switched away
// from before close. Abrupt death is covered separately by temp-identities.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'dist', 'cli.js');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const freePort = () => new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    server.close(() => resolve(port));
  });
});

let pass = 0;
let fail = 0;
const ok = (condition, message) => {
  if (condition) { pass++; console.log('  ✓', message); }
  else { fail++; console.log('  ✗ FAIL:', message); }
};

async function connectProxy(sessionEnv, clientName) {
  const child = spawn(process.execPath, [CLI, 'proxy'], { env: sessionEnv, stdio: ['pipe', 'pipe', 'ignore'] });
  let nextId = 1;
  let buffer = '';
  const pending = new Map();
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let frame;
      try { frame = JSON.parse(line); } catch { continue; }
      if (frame.id != null && pending.has(frame.id)) {
        pending.get(frame.id)(frame);
        pending.delete(frame.id);
      }
    }
  });
  const request = (method, params) => new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const init = await request('initialize', {
    protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: clientName, version: '0' },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  return {
    child,
    initialized: Boolean(init.result),
    call: (name, args = {}) => request('tools/call', { name, arguments: args }),
  };
}

async function stopProxy(child) {
  if (!child) return;
  try { child.stdin.end(); } catch { /* already gone */ }
  await Promise.race([once(child, 'exit'), sleep(1_000)]).catch(() => {});
  if (child.exitCode == null) child.kill('SIGKILL');
}

const stateDir = mkdtempSync(join(tmpdir(), 'ours-session-end-'));
const port = await freePort();
const sessionId = `session-end-${process.pid}`;
const env = {
  ...process.env,
  CLAUDE_CODE_SESSION_ID: sessionId,
  OURS_AUTOSTART: 'false',
  OURS_API_VISIBILITY: 'open',
  OURS_BROKER_URL: 'wss://invalid.local/none',
  OURS_PORT: String(port),
  OURS_STATE_DIR: stateDir,
  OURS_TRANSPORT: 'http',
};
const proxyEnv = { ...env };
delete proxyEnv.OURS_AUTOSTART;
delete proxyEnv.OURS_BROKER_URL;
delete proxyEnv.OURS_TRANSPORT;

const daemon = spawn(process.execPath, [CLI, 'serve'], { env, stdio: 'ignore' });
let proxy;
try {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/version`)).ok) break; } catch { /* booting */ }
    await sleep(100);
  }

  let connected = await connectProxy(proxyEnv, 'claude-session-end-test');
  proxy = connected.child;
  let call = connected.call;
  ok(connected.initialized, 'Claude-style proxy session initialized');

  const human = await call('create_identity', { name: 'Human', expose_local: false });
  ok(Boolean(human.result) && !human.result.isError, 'Human/root created');
  const first = await call('create_temporary_identity', { name: 'EphemeralOne' });
  ok(Boolean(first.result) && !first.result.isError, 'first delegated temporary role created');
  const second = await call('create_temporary_identity', { name: 'EphemeralTwo' });
  ok(Boolean(second.result) && !second.result.isError, 'second delegated temporary role created after switching away');
  ok(existsSync(join(stateDir, 'EphemeralOne')) && existsSync(join(stateDir, 'EphemeralTwo')), 'both temporary role states exist before SessionEnd');

  const hook = spawn(process.execPath, [CLI, 'session-end'], { env, stdio: 'ignore' });
  const started = Date.now();
  const [code, signal] = await once(hook, 'exit');
  ok(code === 0 && signal === null, `session-end hook exits cleanly (code=${code}, signal=${signal})`);
  ok(!existsSync(join(stateDir, 'EphemeralOne')) && !existsSync(join(stateDir, 'EphemeralTwo')), 'SessionEnd returns only after all session-owned temporary state is deleted');
  ok(existsSync(join(stateDir, 'Human')), 'SessionEnd preserves permanent Human/root state');
  ok(Date.now() - started < 5_000, 'normal SessionEnd cleanup is immediate');

  await stopProxy(proxy);
  proxy = undefined;

  // Codex has no CLAUDE_CODE_SESSION_ID, so both proxy and hook derive the
  // same lease from the stable OURS_CLIENT_PID supplied by the harness shim.
  const codexEnv = { ...proxyEnv, OURS_CLIENT_PID: String(process.pid) };
  delete codexEnv.CLAUDE_CODE_SESSION_ID;
  connected = await connectProxy(codexEnv, 'codex-session-end-test');
  proxy = connected.child;
  call = connected.call;
  ok(connected.initialized, 'Codex-style proxy session initialized from a stable client pid');
  const codexFirst = await call('create_temporary_identity', { name: 'CodexEphemeralOne' });
  ok(Boolean(codexFirst.result) && !codexFirst.result.isError, 'Codex first delegated temporary role created');
  const codexSecond = await call('create_temporary_identity', { name: 'CodexEphemeralTwo' });
  ok(Boolean(codexSecond.result) && !codexSecond.result.isError, 'Codex second delegated temporary role created after switching away');
  const codexHook = spawn(process.execPath, [CLI, 'session-end'], { env: codexEnv, stdio: 'ignore' });
  const [codexCode, codexSignal] = await once(codexHook, 'exit');
  ok(codexCode === 0 && codexSignal === null, `Codex session-end hook exits cleanly (code=${codexCode}, signal=${codexSignal})`);
  ok(
    !existsSync(join(stateDir, 'CodexEphemeralOne')) && !existsSync(join(stateDir, 'CodexEphemeralTwo')),
    'Codex SessionEnd returns only after all stable-pid-owned temporary state is deleted',
  );
} finally {
  await stopProxy(proxy);
  if (daemon.exitCode == null) daemon.kill('SIGTERM');
  await Promise.race([once(daemon, 'exit'), sleep(1_000)]).catch(() => {});
  rmSync(stateDir, { recursive: true, force: true });
}

console.log(`\nsession-end-temp-cleanup: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
