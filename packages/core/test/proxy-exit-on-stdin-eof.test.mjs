// proxy-exit-on-stdin-eof — when the client goes away, the proxy must go away.
//
// THE DEFECT. `runProxy` registered exactly three exits: SIGINT, SIGTERM, and
// `down.onclose → shutdown(0)`. `down` is the MCP SDK's StdioServerTransport,
// whose start() registers ONLY 'data' and 'error' on stdin — no 'end', no
// 'close' — and which invokes `onclose?.()` ONLY from its own close(). The proxy
// calls down.close() solely inside shutdown(). So onclose could fire only after
// the very thing it was meant to trigger had already happened, and stdin EOF —
// the only signal a departing client actually sends — reached nobody.
//
// WHAT THAT COST, measured on ours-mcp 0.16.0 before this fix: an orphaned proxy
// held ~134 MB resident indefinitely and, once the daemon reaped its session for
// a dead client pid, spun a full CPU core forever. The reconnect that follows
// each reap opens a NEW session, which is reaped for the same reason — so a dead
// client also bills a LIVE daemon, permanently.
//
// WHY THE OBVIOUS ALTERNATIVES ARE NOT THE FIX:
//   • SIGHUP is delivered only to the foreground process group of a controlling
//     terminal. A harness that spawns an MCP stdio server over pipes has no tty
//     (TT=?), so the hangup has no addressee. Verified: a proxy under a real pty
//     dies when the pty master closes; an orphan with no tty does not.
//   • The uncaughtException handler cannot be relied on to end it either — it is
//     deliberately "proxy stays up", so even an EPIPE on dead stdio is swallowed.
//
// This test asserts only the guarantee, not the implementation: EOF on stdin ⇒
// the process exits. Before the fix it hangs until the timeout and FAILS.
//
// Run after build.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'dist', 'cli.js');
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓', m)) : (fail++, console.log('  ✗ FAIL:', m)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = createNetServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

// A minimal daemon that completes the handshake and then HOLDS the standalone
// notification SSE open. Holding it open is the point: that stream is what keeps
// the orphan's event loop alive, so a proxy that does not handle EOF has every
// reason to stay running and this test can tell "exited" from "had nothing to do".
async function startQuietDaemon() {
  const held = [];
  let sessionId = null;
  const srv = createServer(async (req, res) => {
    if (req.url === '/state-dir') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ stateDir: '/tmp/fake', version: '0.0.0-test', compat: 1 }));
      return;
    }
    if (req.url !== '/mcp') { res.writeHead(404); res.end(); return; }
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      held.push(res); // never ended — the loop-keeping handle
      return;
    }
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    let raw = '';
    for await (const c of req) raw += c;
    let body; try { body = JSON.parse(raw); } catch { res.writeHead(400); res.end(); return; }
    const msgs = Array.isArray(body) ? body : [body];
    const req0 = msgs.find((m) => m.method && m.id !== undefined);
    if (!req0) { res.writeHead(202); res.end(); return; }
    sessionId = sessionId ?? randomUUID();
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'mcp-session-id': sessionId });
    const result = req0.method === 'initialize'
      ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'quiet', version: '0' } }
      : { tools: [] };
    res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: req0.id, result })}\n\n`);
    res.end();
  });
  const port = await freePort();
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  return {
    port,
    close: () => { for (const r of held) { try { r.end(); } catch { /* gone */ } } return new Promise((r) => srv.close(r)); },
  };
}

function startProxy(port, dir) {
  const p = spawn('node', [CLI, 'proxy'], {
    env: {
      ...process.env,
      OURS_PORT: String(port), OURS_STATE_DIR: dir,
      OURS_API_VISIBILITY: 'open', OURS_AUTOSTART: 'false',
      OURS_NO_AUTORESTORE: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const frames = [];
  let buf = '';
  p.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (line) { try { frames.push(JSON.parse(line)); } catch { /* not a frame */ } }
    }
  });
  p.stderr.resume();
  const exited = new Promise((res) => p.on('exit', (code, sig) => res({ code, sig, at: Date.now() })));
  return { proc: p, frames, exited, send: (m) => p.stdin.write(JSON.stringify(m) + '\n'), kill: () => { try { p.kill('SIGKILL'); } catch { /* gone */ } } };
}

async function waitFor(frames, pred, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const hit = frames.find(pred);
    if (hit) return hit;
    await sleep(50);
  }
  return null;
}

console.log('proxy-exit-on-stdin-eof\n');

// ─── THE HEADLINE: a fully established proxy exits when stdin reaches EOF ────
{
  console.log('established session → stdin EOF → process exits');
  const dir = mkdtempSync(join(tmpdir(), 'ours-eof-'));
  const daemon = await startQuietDaemon();
  const px = startProxy(daemon.port, dir);
  try {
    // Reach genuine steady state first. An unestablished proxy might exit for
    // unrelated reasons; we want to prove the EOF path, not a startup failure.
    px.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'eof-test', version: '0' } } });
    const init = await waitFor(px.frames, (f) => f.id === 1 && f.result, 15000);
    ok(Boolean(init), 'proxy completed the handshake against the fake daemon');
    px.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    px.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    ok(Boolean(await waitFor(px.frames, (f) => f.id === 2 && f.result, 10000)), 'proxy is serving — a tool call round-tripped');
    await sleep(500); // let the standalone notification SSE settle open

    const t0 = Date.now();
    px.proc.stdin.end(); // THE ONLY SIGNAL A DEPARTING CLIENT SENDS

    // Before the fix nothing listens for this and the race resolves to null.
    const outcome = await Promise.race([px.exited, sleep(10000).then(() => null)]);
    const waited = Date.now() - t0;
    ok(Boolean(outcome), `proxy exited after stdin EOF (${waited}ms) — it no longer outlives its client`);
    if (outcome) {
      ok(outcome.code === 0, `exited cleanly with code 0 (got code=${outcome.code} sig=${outcome.sig}) — a departing client is not an error`);
      ok(waited < 5000, `exited promptly (${waited}ms), rather than lingering on the notification stream`);
    }
  } finally { px.kill(); await daemon.close(); rmSync(dir, { recursive: true, force: true }); }
}

// ─── THE GUARD: it must not exit while the client is still there ─────────────
// A fix that exits eagerly would be worse than the defect — every idle session
// would drop its binding. Prove the new listeners fire on EOF and nothing else.
{
  console.log('\nquiet but connected client → proxy stays up');
  const dir = mkdtempSync(join(tmpdir(), 'ours-eof-'));
  const daemon = await startQuietDaemon();
  const px = startProxy(daemon.port, dir);
  try {
    px.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'eof-test', version: '0' } } });
    ok(Boolean(await waitFor(px.frames, (f) => f.id === 1 && f.result, 15000)), 'proxy completed the handshake');
    px.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    // Say nothing for a while. stdin stays OPEN — the client is simply idle.
    const early = await Promise.race([px.exited, sleep(6000).then(() => null)]);
    ok(early === null, 'proxy stayed up through 6s of client silence — an open, idle stdin is not a departure');
  } finally { px.kill(); await daemon.close(); rmSync(dir, { recursive: true, force: true }); }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
