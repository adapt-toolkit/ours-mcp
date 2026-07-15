// Leak #2 — dead-client session reaper.
//
// Regression suite for the per-connection churn leak: transport.onclose does NOT fire on an abrupt
// client disconnect (SIGKILL / crash / claude restart), so the per-session McpServer + its ~zod
// tool-schema bindings orphan in serversBySession/transports/sessionHeaders forever. The daemon reaps
// sessions whose x-ours-client-pid is OS-confirmed-dead (on new-session init + a 60s sweep), and
// deref → GC frees the server. Also guards the onclose-recursion regression (server.close() inside
// transport.onclose = infinite recursion → RangeError thrash masquerading as a leak).
//
// Covers: dead-client sessions ARE reaped; a LIVE-client session is NOT reaped; ZERO RangeError under
// churn (onclose has no re-entrant close). Per HS's guidance the sessions are REAL connected MCP
// sessions (an unconnected server can't re-enter onclose, so it would miss the recursion).
//
// Self-contained: spawns the BUILT daemon (dist/cli.js serve) on an isolated temp state dir + ephemeral
// port, no broker (session init + reaping are local). Drives sessions through the real `proxy` shim so
// x-ours-client-pid is set exactly as in production. Run after `npm run build`:
//   npm --workspace @ours.network/mcp test
import { spawn } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { mkdtempSync, rmSync, openSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const assert = (cond, msg) => { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗ FAIL:', msg); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'dist', 'cli.js');
const STATE = mkdtempSync(join(tmpdir(), 'a2a-core-reaper-'));
const LOG = join(STATE, 'daemon.log');
const BROKER = 'ws://127.0.0.1:59997/nobroker'; // unreachable on purpose — init + reap are local

// One real MCP session through the proxy shim, reporting `clientPid` as x-ours-client-pid.
// Initializes (→ onsessioninitialized adds it to serversBySession), then disconnects abruptly.
function churnOnce(port, clientPid) {
  return new Promise((resolve) => {
    const env = { ...process.env, OURS_PORT: String(port), OURS_STATE_DIR: STATE, OURS_BROKER_URL: BROKER, OURS_CLIENT_PID: String(clientPid), CLAUDE_CODE_SESSION_ID: 'reaper-test-' + clientPid };
    const p = spawn('node', [CLI, 'proxy'], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '', id = 1; const pend = new Map();
    const send = (method, params) => new Promise((r) => { const i = id++; pend.set(i, r); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); });
    p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!l.trim()) continue; let m; try { m = JSON.parse(l); } catch { continue; } if (m.id != null && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } } });
    (async () => {
      try {
        await send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'reaper-test', version: '0' } });
        p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
        await send('tools/list', {}); // force a round-trip so the session is fully established
      } catch {}
      finally { p.stdin.end(); setTimeout(() => { try { p.kill('SIGKILL'); } catch {} resolve(); }, 100); }
    })();
  });
}

// Spawn a throwaway holder whose pid we hand the daemon, then kill it → the daemon sees a genuinely
// dead LOCAL client pid (models a claude process that exited). Waits for true OS-reap (not a zombie).
function deadPid() {
  return new Promise((resolve) => {
    const h = spawn('sleep', ['3600'], { stdio: 'ignore' });
    const pid = h.pid;
    h.once('exit', () => resolve(pid));
    try { h.kill('SIGKILL'); } catch { resolve(pid); }
    setTimeout(() => resolve(pid), 800);
  });
}

async function main() {
  const port = await freePort();
  const logFd = openSync(LOG, 'w');
  const daemon = spawn('node', [CLI, 'serve'], { env: { ...process.env, OURS_PORT: String(port), OURS_STATE_DIR: STATE, OURS_BROKER_URL: BROKER }, stdio: ['ignore', logFd, logFd] });
  // wait until :port ACCEPTS a TCP connection (daemon bound)
  const canConnect = () => new Promise((r) => { const c = connect(port, '127.0.0.1'); c.once('connect', () => { c.destroy(); r(true); }); c.once('error', () => r(false)); });
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { await sleep(250); up = await canConnect(); }
  if (!up) { console.log('  ✗ FAIL: daemon did not bind :' + port); try { daemon.kill('SIGKILL'); } catch {} console.log(readFileSync(LOG, 'utf8').slice(-800)); process.exit(1); }
  await sleep(500);

  try {
    // ---- churn N sessions, each owned by a distinct DEAD client pid ----
    const N = 8;
    for (let n = 0; n < N; n++) { const pid = await deadPid(); await churnOnce(port, pid); }
    // one more init to trigger the on-new-session reap of the last dead session
    await churnOnce(port, await deadPid());
    await sleep(300);
    const log = readFileSync(LOG, 'utf8');

    const reaped = (log.match(/reaped \(client pid \d+ dead\)/g) || []).length;
    const inits = (log.match(/… initialized/g) || []).length;
    assert(reaped >= N - 1, `dead-client sessions are reaped (${reaped} reaped over ${inits} inits)`);

    // ---- onclose-recursion regression: churn must produce ZERO RangeError ----
    assert(!/RangeError|Maximum call stack/.test(log), 'no RangeError under churn (onclose has no re-entrant server.close)');

    // ---- a LIVE client's session is NEVER reaped ----
    const liveBefore = (log.match(/reaped \(client pid \d+ dead\)/g) || []).length;
    await churnOnce(port, process.pid); // this test process is alive
    await churnOnce(port, await deadPid()); // trigger a reap sweep
    await sleep(300);
    const log2 = readFileSync(LOG, 'utf8');
    assert(!log2.includes(`reaped (client pid ${process.pid} dead)`), 'a live-client session is never reaped');
    assert((log2.match(/reaped \(client pid \d+ dead\)/g) || []).length > liveBefore, 'the reaper still fires for the concurrent dead session');
  } finally {
    try { daemon.kill('SIGKILL'); } catch {}
    await sleep(200);
    rmSync(STATE, { recursive: true, force: true });
  }

  console.log(`\nsession-reaper: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
