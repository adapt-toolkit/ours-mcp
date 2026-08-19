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
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

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
      // Never inherit a supervisor's OURS_BIND_IDENTITY: an ours-fleet-managed host
      // exports it, and it would seed a startup bind these cases never asked for
      // (that input has its own suite — env-bind-identity.test.mjs).
      OURS_BIND_IDENTITY: undefined,
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

// ─── 4. THE ORDERLY-CLOSE HANG — a deterministic reproduction of Defect A ────
//
// This is the reproduction the whole investigation lacked. Before it, the hang was
// n=1 with an unknown cause and every candidate correlation dead; it now arms in
// about a second, in-process, with no timed wait and no network conditions.
//
// THE MECHANISM. When a server transport is closed WITH A REQUEST IN FLIGHT,
// streamController.close() ends the SSE stream CLEANLY. The client's reader sees
// `done` and BREAKS rather than throwing; a POST stream has isReconnectable=false
// and (with no eventStore) no priming event, so needsReconnect is false and the
// loop simply returns. NOTHING rejects the pending response handler.
//   *** AN ORDERLY TEARDOWN OF THE STREAM IS NOT A TEARDOWN OF THE REQUEST. ***
// A clean close is in one sense worse than a crash here: a crash would have thrown.
//
// WHY THIS DOES NOT CONTRADICT THE FIELD MEASUREMENT that abrupt daemon death
// settles in-flight requests (84/84 observed by the reporting fleet): SIGTERM
// ABORTS THE SOCKETS, so the client's fetch rejects and the request fails. SIGTERM
// NEVER REACHES the orderly streamController.close() path this test exercises — it
// aborts first. DIFFERENT TEARDOWN MODES, DIFFERENT OUTCOMES. Both results are
// real; reading only one of them would make the other party look wrong.
//
// This case is the ONLY guard on the orderly mode: the abrupt path is structurally
// incapable of exercising it.
{
  console.log('\norderly close mid-request: the SDK leaves the caller hanging (Defect A, reproduced)');
  let serverTransport = null;
  const srv = createServer(async (req, res) => {
    if (req.method === 'POST') {
      let raw = ''; for await (const c of req) raw += c;
      const body = JSON.parse(raw);
      if (req.headers['mcp-session-id'] && serverTransport) { await serverTransport.handleRequest(req, res, body); return; }
      serverTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
      const mcp = new McpServer({ name: 'hangprobe', version: '0' }, { capabilities: {} });
      mcp.tool('hang', async () => new Promise(() => {})); // never answers
      await mcp.connect(serverTransport);
      await serverTransport.handleRequest(req, res, body);
      return;
    }
    if (req.method === 'GET') { await serverTransport?.handleRequest(req, res); return; }
    res.writeHead(405); res.end();
  });
  srv.requestTimeout = 0;
  const port = await freePort();
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  const ct = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
  const client = new Client({ name: 'hangprobe-client', version: '0' }, { capabilities: {} });
  try {
    await client.connect(ct);
    let settled = null;
    // 120s timeout DELIBERATELY, so the SDK's own 60s DEFAULT_REQUEST_TIMEOUT_MSEC
    // cannot be mistaken for close() having settled the promise.
    client.callTool({ name: 'hang', arguments: {} }, undefined, { timeout: 120000 })
      .then(() => { settled = 'RESOLVED'; })
      .catch((e) => { settled = `REJECTED: ${String(e.message ?? e).slice(0, 80)}`; });
    await sleep(800);
    ok(settled === null, 'request is genuinely in flight before we close');
    await serverTransport.close();      // the exact call the daemon shutdown makes
    await sleep(3000);
    // IF THIS ASSERTION EVER FAILS, THE MCP SDK CHANGED — OUR CODE DID NOT BREAK.
    // A newer SDK that rejects pending handlers on a clean stream close would be a
    // welcome upstream fix, and it would mean the proxy watchdog has quietly stopped
    // being the only thing standing between this shape and an infinite wait.
    // Re-read _handleSseStream's `done` path before assuming a regression here.
    ok(settled === null,
      `SDK STILL LEAVES THE PROMISE UNSETTLED after an orderly close (got: ${settled ?? 'unsettled'}) — if this FAILS, the SDK changed, our code did not break`);
  } finally {
    try { await client.close(); } catch { /* ignore */ }
    srv.closeAllConnections?.(); await new Promise((r) => srv.close(r));
  }
}

// ─── 4b. …and the proxy converts that exact shape into a prompt error ────────
// The synthetic stream-kill case (1) and this one exercise the SAME guarantee
// through DIFFERENT failure shapes. That is not duplication: the trigger for the
// reported hang is still unknown, so covering the defect class matters more than
// covering one path into it.
{
  console.log('\n…and the proxy fails that same orderly-close shape back promptly');
  const dir = mkdtempSync(join(tmpdir(), 'ours-fb-oc-'));
  let st = null;
  const srv = createServer(async (req, res) => {
    if (req.url === '/state-dir') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ stateDir: '/tmp/fake', version: '0.0.0-test', compat: 1 })); return; }
    if (req.method === 'POST') {
      let raw = ''; for await (const c of req) raw += c;
      const body = JSON.parse(raw);
      if (req.headers['mcp-session-id'] && st) { await st.handleRequest(req, res, body); return; }
      st = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
      const mcp = new McpServer({ name: 'hangd', version: '0' }, { capabilities: {} });
      mcp.tool('get_messages', async () => new Promise(() => {}));
      await mcp.connect(st);
      await st.handleRequest(req, res, body);
      return;
    }
    if (req.method === 'GET') { await st?.handleRequest(req, res); return; }
    res.writeHead(405); res.end();
  });
  srv.requestTimeout = 0;
  const port = await freePort();
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  const px = startProxy(port, dir, { OURS_REQUEST_TIMEOUT_MS: '4000' });
  try {
    px.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    ok(Boolean(await waitFor(px.frames, (f) => f.id === 1 && f.result, 15000)), 'handshake completed');
    px.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await sleep(400);
    const t0 = Date.now();
    px.send({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'get_messages', arguments: {} } });
    await sleep(1000);
    await st.close();
    const err = await waitFor(px.frames, (f) => f.id === 11 && f.error, 15000);
    ok(Boolean(err), `caller got a response ${Date.now() - t0}ms after an orderly close that the SDK never settles`);
    if (err) ok(err.error.code === -32001 || err.error.code === -32000, `MCP error code ${err.error.code}`);
  } finally { px.kill(); srv.closeAllConnections?.(); await new Promise((r) => srv.close(r)); rmSync(dir, { recursive: true, force: true }); }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
