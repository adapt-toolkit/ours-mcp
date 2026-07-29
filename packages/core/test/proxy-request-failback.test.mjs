// proxy-request-failback — a request that can never be answered must come back as
// a JSON-RPC error, not hang the caller forever.
//
// THE DEFECT. A POST response stream that breaks is never retried by the MCP SDK
// (isReconnectable=false for POST streams and, with no eventStore, no priming
// event, so needsReconnect=false). transport.onerror does fire, but it carries NO
// request id, so nothing in the proxy can correlate it to the waiting call. The
// caller waits forever. Nothing throws, so this defect is invisible to ordinary
// tests — which is exactly why this test exists and why it asserts a BOUNDED
// FAILURE rather than a happy path.
//
// WHAT IT DOES NOT CLAIM. This does not prevent the hang and takes no position on
// what causes it. It proves the wait is bounded and the caller is told. Note also
// that this protects the PROXY path only; clients reaching the daemon directly get
// nothing from it.
//
// The fake daemon here accepts the POST (so the request genuinely reached the
// server and may well have executed) and then kills the response stream without
// answering — the precise shape of the lost request.
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

// A daemon that answers `initialize` normally, then accepts a tools/call POST and
// KILLS its response stream without ever answering.
async function startBlackHoleDaemon() {
  let sessionId = null;
  let swallowed = 0;
  const srv = createServer(async (req, res) => {
    if (req.url === '/state-dir') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ stateDir: '/tmp/fake', version: '0.0.0-test', compat: 1 }));
      return;
    }
    if (req.url !== '/mcp') { res.writeHead(404); res.end(); return; }
    if (req.method === 'GET') { // standalone notification SSE — hold it open
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      return;
    }
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    let raw = '';
    for await (const c of req) raw += c;
    let body; try { body = JSON.parse(raw); } catch { res.writeHead(400); res.end(); return; }
    const msgs = Array.isArray(body) ? body : [body];
    const req0 = msgs.find((m) => m.method && m.id !== undefined);

    if (!req0) { res.writeHead(202); res.end(); return; } // notifications

    if (req0.method === 'initialize') {
      sessionId = randomUUID();
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'mcp-session-id': sessionId });
      res.write(`event: message\ndata: ${JSON.stringify({
        jsonrpc: '2.0', id: req0.id,
        result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'blackhole', version: '0' } },
      })}\n\n`);
      res.end();
      return;
    }
    // THE BLACK HOLE: accept the request, open the response stream, then destroy it
    // without answering. From the client's side the POST succeeded.
    swallowed++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    setTimeout(() => { try { res.socket?.destroy(); } catch { /* already gone */ } }, 150);
  });
  const port = await freePort();
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  return { port, close: () => new Promise((r) => srv.close(r)), swallowedCount: () => swallowed };
}

// Drive the proxy over stdio and collect the JSON-RPC frames it emits.
function startProxy(port, dir, extraEnv) {
  const p = spawn('node', [CLI, 'proxy'], {
    env: {
      ...process.env,
      OURS_PORT: String(port), OURS_STATE_DIR: dir,
      OURS_API_VISIBILITY: 'open', OURS_AUTOSTART: 'false',
      OURS_NO_AUTORESTORE: '1', // keep the test hermetic
      ...extraEnv,
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
  const stderr = [];
  p.stderr.on('data', (d) => stderr.push(d.toString()));
  return {
    proc: p, frames, stderr,
    send: (m) => p.stdin.write(JSON.stringify(m) + '\n'),
    kill: () => { try { p.kill('SIGKILL'); } catch { /* gone */ } },
  };
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

console.log('proxy-request-failback\n');

// ─── 1. THE HEADLINE: a broken response stream fails back, promptly ──────────
{
  console.log('lost request → prompt JSON-RPC error (watchdog 3s)');
  const dir = mkdtempSync(join(tmpdir(), 'ours-fb-'));
  const daemon = await startBlackHoleDaemon();
  const px = startProxy(daemon.port, dir, { OURS_REQUEST_TIMEOUT_MS: '3000' });
  try {
    px.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'failback-test', version: '0' } } });
    const init = await waitFor(px.frames, (f) => f.id === 1 && f.result, 15000);
    ok(Boolean(init), 'proxy completed the handshake against the fake daemon');
    px.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await sleep(300);

    const t0 = Date.now();
    px.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_messages', arguments: {} } });

    // Without the fix this waits forever and the test times out.
    const err = await waitFor(px.frames, (f) => f.id === 2 && f.error, 12000);
    const waited = Date.now() - t0;
    ok(Boolean(err), `caller received a response for the lost request after ${waited}ms (instead of hanging forever)`);
    if (err) {
      // Either trigger is a correct outcome here: killing the stream can also tear
      // down the transport, in which case the death sweep answers sooner than the
      // watchdog. Both are MCP's own codes; test 1b isolates the watchdog alone.
      ok(err.error.code === -32000 || err.error.code === -32001,
        `error code is one of MCP's own — ConnectionClosed -32000 / RequestTimeout -32001 (got ${err.error.code})`);
      ok(/not retried/i.test(err.error.message), 'message states the request was NOT retried — caller decides whether repeating is safe');
      ok(err.error.data?.method === 'tools/call', `error data names the method (${err.error.data?.method})`);
      ok(typeof err.error.data?.waitedMs === 'number', `error data carries waitedMs=${err.error.data?.waitedMs} — the evidence for diagnosing the real cause`);
      ok(waited < 9000, `failed back promptly (${waited}ms, watchdog was 3000ms)`);
    }
    // THE SAFETY PROPERTY. A rejected send used to be re-queued and replayed by
    // reconnect() on the false premise that it never reached the daemon — which
    // would run get_messages a second time and consume mail that reaches nobody.
    await sleep(1500); // give any replay time to arrive
    ok(daemon.swallowedCount() === 1,
      `the request reached the daemon EXACTLY ONCE (${daemon.swallowedCount()}) — never replayed, so get_messages cannot double-consume mail`);
  } finally { px.kill(); await daemon.close(); rmSync(dir, { recursive: true, force: true }); }
}

// ─── 1b. ISOLATE THE WATCHDOG: stream stays OPEN, answer never comes ─────────
// No transport death here, so the death sweep cannot fire. Only the watchdog can
// end this wait — which is the cause-agnostic guarantee, and the one that has to
// hold when the hang has a cause we have not identified.
{
  console.log('\nwatchdog alone: stream held open, answer never sent');
  const dir = mkdtempSync(join(tmpdir(), 'ours-fb-wd-'));
  let sessionId = null;
  let calls = 0;
  const srv = createServer(async (req, res) => {
    if (req.url === '/state-dir') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ stateDir: '/tmp/fake', version: '0.0.0-test', compat: 1 })); return; }
    if (req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' }); return; }
    let raw = ''; for await (const c of req) raw += c;
    let body; try { body = JSON.parse(raw); } catch { res.writeHead(400); res.end(); return; }
    const msgs = Array.isArray(body) ? body : [body];
    const r0 = msgs.find((m) => m.method && m.id !== undefined);
    if (!r0) { res.writeHead(202); res.end(); return; }
    if (r0.method === 'initialize') {
      sessionId = randomUUID();
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'mcp-session-id': sessionId });
      res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: r0.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'silent', version: '0' } } })}\n\n`);
      res.end();
      return;
    }
    calls++;
    // Open the SSE response and hold it open forever, answering nothing.
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  });
  const port = await freePort();
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  const px = startProxy(port, dir, { OURS_REQUEST_TIMEOUT_MS: '3000' });
  try {
    px.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    ok(Boolean(await waitFor(px.frames, (f) => f.id === 1 && f.result, 15000)), 'handshake completed');
    px.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await sleep(300);
    const t0 = Date.now();
    px.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_messages', arguments: {} } });
    const err = await waitFor(px.frames, (f) => f.id === 3 && f.error, 12000);
    const waited = Date.now() - t0;
    ok(Boolean(err), `watchdog ended the wait after ${waited}ms with no transport death involved`);
    if (err) {
      ok(err.error.code === -32001, `error code is MCP's RequestTimeout -32001 (got ${err.error.code})`);
      ok(err.error.data?.reason === 'watchdog timeout', `reason names the watchdog (${err.error.data?.reason})`);
      ok(waited >= 3000 && waited < 6000, `fired at the configured deadline, not early (${waited}ms for a 3000ms watchdog)`);
    }
    ok(calls === 1, `request reached the daemon exactly once (${calls})`);
  } finally { px.kill(); await new Promise((r) => srv.close(r)); rmSync(dir, { recursive: true, force: true }); }
}

// ─── 2. CONTROL: watchdog disabled reproduces the hang ───────────────────────
// If this ever "passes" by producing a response, test 1 is not measuring the fix.
{
  console.log('\ncontrol: watchdog disabled (OURS_REQUEST_TIMEOUT_MS=0) — the hang must reproduce');
  const dir = mkdtempSync(join(tmpdir(), 'ours-fb-off-'));
  const daemon = await startBlackHoleDaemon();
  const px = startProxy(daemon.port, dir, { OURS_REQUEST_TIMEOUT_MS: '0' });
  try {
    px.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'failback-test', version: '0' } } });
    ok(Boolean(await waitFor(px.frames, (f) => f.id === 1 && f.result, 15000)), 'handshake completed');
    px.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await sleep(300);
    px.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_messages', arguments: {} } });
    const any = await waitFor(px.frames, (f) => f.id === 2, 8000);
    ok(any === null, 'with the watchdog off the caller gets NOTHING back — the reported hang, reproduced');
  } finally { px.kill(); await daemon.close(); rmSync(dir, { recursive: true, force: true }); }
}

// ─── 3. a healthy call must NOT be failed back ───────────────────────────────
{
  console.log('\nno false positives: a normal call answers well inside the watchdog');
  const dir = mkdtempSync(join(tmpdir(), 'ours-fb-ok-'));
  let sessionId = null;
  const srv = createServer(async (req, res) => {
    if (req.url === '/state-dir') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ stateDir: '/tmp/fake', version: '0.0.0-test', compat: 1 })); return; }
    if (req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' }); return; }
    let raw = ''; for await (const c of req) raw += c;
    let body; try { body = JSON.parse(raw); } catch { res.writeHead(400); res.end(); return; }
    const msgs = Array.isArray(body) ? body : [body];
    const r0 = msgs.find((m) => m.method && m.id !== undefined);
    if (!r0) { res.writeHead(202); res.end(); return; }
    sessionId = sessionId ?? randomUUID();
    const result = r0.method === 'initialize'
      ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'ok', version: '0' } }
      : { content: [{ type: 'text', text: 'fine' }] };
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'mcp-session-id': sessionId });
    res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: r0.id, result })}\n\n`);
    res.end();
  });
  const port = await freePort();
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  const px = startProxy(port, dir, { OURS_REQUEST_TIMEOUT_MS: '3000' });
  try {
    px.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    ok(Boolean(await waitFor(px.frames, (f) => f.id === 1 && f.result, 15000)), 'handshake completed');
    px.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await sleep(300);
    px.send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'current_identity', arguments: {} } });
    const good = await waitFor(px.frames, (f) => f.id === 5, 8000);
    ok(Boolean(good && good.result), 'healthy call returned its RESULT');
    await sleep(4000); // outlive the 3s watchdog
    const spurious = px.frames.filter((f) => f.id === 5 && f.error);
    ok(spurious.length === 0, 'no spurious error was emitted after the answer arrived');
  } finally { px.kill(); await new Promise((r) => srv.close(r)); rmSync(dir, { recursive: true, force: true }); }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
