// sse-keepalive — long-lived SSE streams must survive a client's inter-chunk
// read timeout, because the daemon keeps them warm with comment frames.
//
// WHY THE OBVIOUS TEST IS THE WRONG TEST.
// The tempting assertions are "keepalive frames are emitted at the expected
// cadence" or "a stream with traffic on it survives". Both pass against a
// mechanism ADJACENT to the real one, and both would still pass if the fix did
// nothing:
//   - traffic obviously prevents an inter-chunk timeout. Busy streams were never
//     the ones dying; only IDLE ones were.
//   - frames being EMITTED proves nothing if they sit unflushed in a buffer, get
//     coalesced, or are held by a compression layer. An unflushed comment is
//     indistinguishable from no keepalive at all.
// The unvalidated question is whether a comment frame REACHES THE CLIENT AS A BODY
// CHUNK and resets that timer. So the real guard is: an idle stream carrying ONLY
// comment frames survives past the timeout — and, to prove the test can fail, the
// same stream with keepalive disabled must die at it.
//
// WHAT THIS DRIVES. The REAL shipped armSseKeepalive from ../dist/sse-keepalive.js,
// mounted on a real node http server in front of the REAL MCP
// StreamableHTTPServerTransport — i.e. the same @hono/node-server write path the
// daemon uses. It deliberately does NOT boot the full daemon: the identity/mufl
// stack is irrelevant to SSE framing, and requiring a compiled packet would make
// this untestable in a checkout whose submodule is mid-change.
//
// Test 1 runs end-to-end at a scaled interval on every run.
// Test 2 is the unscaled version against undici's real 300s default. It is slow
// (~11 min with its control), so it is opt-in: OURS_SLOW_SSE_TEST=1.
//
// Run after build.

import { createServer } from 'node:http';
import { createServer as createNetServer, connect } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const { armSseKeepalive, KEEPALIVE_FRAME, sseKeepaliveMs, DEFAULT_SSE_KEEPALIVE_MS } =
  await import(join(HERE, '..', 'dist', 'sse-keepalive.js'));
const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓', m)) : (fail++, console.log('  ✗ FAIL:', m)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = createNetServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

// A minimal stand-in for the daemon's /mcp surface: the real SDK transport, the
// real hono write path, and armSseKeepalive wired exactly where index.ts wires it.
async function startServer(keepaliveMs) {
  const transports = {};
  const srv = createServer(async (req, res) => {
    if (req.url !== '/mcp') { res.writeHead(404); res.end(); return; }
    if (req.method === 'POST') {
      let raw = '';
      for await (const c of req) raw += c;
      const body = JSON.parse(raw);
      const sid = req.headers['mcp-session-id'];
      if (sid && transports[sid]) {
        if (keepaliveMs !== undefined) armSseKeepalive(res, keepaliveMs);
        await transports[sid].handleRequest(req, res, body);
        return;
      }
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => { transports[id] = transport; },
      });
      const mcp = new McpServer({ name: 'sse-keepalive-test', version: '0' }, { capabilities: {} });
      await mcp.connect(transport);
      if (keepaliveMs !== undefined) armSseKeepalive(res, keepaliveMs);
      await transport.handleRequest(req, res, body);
      return;
    }
    if (req.method === 'GET') {
      const sid = req.headers['mcp-session-id'];
      if (!sid || !transports[sid]) { res.writeHead(400); res.end('bad session'); return; }
      if (keepaliveMs !== undefined) armSseKeepalive(res, keepaliveMs);
      await transports[sid].handleRequest(req, res);
      return;
    }
    res.writeHead(405); res.end();
  });
  srv.requestTimeout = 0; // as the daemon does, so Node's own 300s timer is not the thing under test
  const port = await freePort();
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  return { port, close: () => new Promise((r) => srv.close(r)) };
}

async function initSession(port) {
  const r = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'ka-test', version: '0' } },
    }),
  });
  const sid = r.headers.get('mcp-session-id');
  await r.text(); // drain so the POST stream closes
  return sid;
}

// Open the standalone GET SSE stream on a RAW socket, recording each chunk with
// its arrival time. Raw socket rather than fetch so we see the wire directly —
// including chunked-transfer framing, i.e. that each keepalive is its own chunk.
function openRawSse(port, sid) {
  const s = connect(port, '127.0.0.1');
  const chunks = [];
  const t0 = Date.now();
  s.on('error', () => { /* closed under us; the assertions read `chunks` */ });
  s.on('connect', () => {
    s.write(
      `GET /mcp HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
      `Accept: text/event-stream\r\nmcp-session-id: ${sid}\r\n` +
      `mcp-protocol-version: 2025-03-26\r\nConnection: keep-alive\r\n\r\n`,
    );
  });
  s.on('data', (d) => chunks.push({ at: Date.now() - t0, text: d.toString() }));
  return { chunks, close: () => { try { s.destroy(); } catch { /* gone */ } } };
}

console.log('sse-keepalive\n');

// ─── 0. config resolution ────────────────────────────────────────────────────
{
  console.log('interval config');
  ok(sseKeepaliveMs({}) === DEFAULT_SSE_KEEPALIVE_MS, `default is ${DEFAULT_SSE_KEEPALIVE_MS}ms (12x margin under 300s)`);
  ok(sseKeepaliveMs({ OURS_SSE_KEEPALIVE_MS: '0' }) === 0, 'OURS_SSE_KEEPALIVE_MS=0 disables');
  ok(sseKeepaliveMs({ OURS_SSE_KEEPALIVE_MS: '1234' }) === 1234, 'OURS_SSE_KEEPALIVE_MS is honoured');
  ok(sseKeepaliveMs({ OURS_SSE_KEEPALIVE_MS: 'nonsense' }) === DEFAULT_SSE_KEEPALIVE_MS, 'garbage falls back to the default rather than disabling');
}

// ─── 1. idle stream really receives flushed frames, through the real transport ─
{
  console.log('\nidle stream, keepalive ON (scaled 300ms)');
  const srv = await startServer(300);
  try {
    const sid = await initSession(srv.port);
    ok(Boolean(sid), `session established (${sid ? sid.slice(0, 8) + '…' : 'none'})`);

    const sse = openRawSse(srv.port, sid);
    await sleep(3000); // COMPLETELY IDLE — no requests, no notifications
    sse.close();

    const ka = sse.chunks.filter((c) => c.text.includes(KEEPALIVE_FRAME.trim()));
    ok(ka.length >= 5, `idle stream received ${ka.length} keepalive frames in 3s (expected >=5 at 300ms)`);

    // Spread over wall-clock proves they were flushed one at a time rather than
    // buffered and released together at close.
    const spread = ka.length >= 2 ? ka[ka.length - 1].at - ka[0].at : 0;
    ok(spread > 1500, `keepalives spread over ${spread}ms of wall clock — flushed individually, not coalesced`);

    // And each must appear on the wire as its own chunked-transfer chunk.
    const framed = sse.chunks.some((c) => /(^|\r\n)6\r\n: ka\n\n\r\n/.test(c.text));
    ok(framed, 'keepalive observed on the wire as its own chunked-transfer chunk (6\\r\\n: ka\\n\\n\\r\\n)');
  } finally { await srv.close(); }
}

// ─── 2. the control — proves test 1 measures the fix, not the transport ───────
{
  console.log('\ncontrol: idle stream, keepalive OFF');
  const srv = await startServer(0);
  try {
    const sid = await initSession(srv.port);
    const sse = openRawSse(srv.port, sid);
    await sleep(3000);
    sse.close();
    const ka = sse.chunks.filter((c) => c.text.includes(KEEPALIVE_FRAME.trim()));
    ok(ka.length === 0, `keepalive disabled produced ${ka.length} frames (expected 0)`);
  } finally { await srv.close(); }
}

// ─── 3. a keepalive must never corrupt a real SSE message frame ───────────────
{
  console.log('\ninterleaving: keepalives must not split a real event frame');
  const srv = await startServer(5); // absurdly aggressive, to maximise interleaving pressure
  try {
    const sid = await initSession(srv.port);
    // A real request/response over a POST SSE stream while keepalives hammer it.
    const r = await fetch(`http://127.0.0.1:${srv.port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
        'mcp-session-id': sid, 'mcp-protocol-version': '2025-03-26',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }),
    });
    const text = await r.text();
    const dataLines = text.split('\n').filter((l) => l.startsWith('data: '));
    ok(dataLines.length >= 1, `response arrived over the SSE stream (${dataLines.length} data line(s))`);
    let parsedOk = false;
    try { parsedOk = JSON.parse(dataLines[0].slice(6)).id === 2; } catch { parsedOk = false; }
    ok(parsedOk, 'the JSON-RPC frame parsed intact despite 5ms keepalive pressure');
  } finally { await srv.close(); }
}

// ─── 4. THE REAL THING: unscaled, against undici's actual 300s bodyTimeout ────
if (process.env.OURS_SLOW_SSE_TEST === '1') {
  const WINDOW_MS = 330_000; // comfortably past undici's 300s inter-chunk default

  // Read the SSE stream via global fetch — deliberately the SAME undici path that
  // dies in the field — and report how long it survived while completely idle.
  async function surviveIdle(port, sid, ms) {
    const t0 = Date.now();
    try {
      const r = await fetch(`http://127.0.0.1:${port}/mcp`, {
        headers: { Accept: 'text/event-stream', 'mcp-session-id': sid, 'mcp-protocol-version': '2025-03-26' },
      });
      const reader = r.body.getReader();
      const deadline = Date.now() + ms;
      for (;;) {
        const left = deadline - Date.now();
        if (left <= 0) return { survivedMs: Date.now() - t0, error: null };
        const out = await Promise.race([reader.read(), sleep(left).then(() => 'deadline')]);
        if (out === 'deadline') return { survivedMs: Date.now() - t0, error: null };
        if (out.done) return { survivedMs: Date.now() - t0, error: 'stream ended' };
      }
    } catch (e) {
      return { survivedMs: Date.now() - t0, error: String(e && e.message ? e.message : e) };
    }
  }

  {
    console.log(`\nSLOW: idle stream, keepalive ON (default ${DEFAULT_SSE_KEEPALIVE_MS}ms) — must survive ${WINDOW_MS / 1000}s`);
    const srv = await startServer(DEFAULT_SSE_KEEPALIVE_MS);
    try {
      const sid = await initSession(srv.port);
      const r = await surviveIdle(srv.port, sid, WINDOW_MS);
      console.log(`    survived ${Math.round(r.survivedMs / 1000)}s, error=${r.error ?? 'none'}`);
      ok(r.error === null && r.survivedMs >= WINDOW_MS - 2000,
        `idle SSE stream survived past 300s (${Math.round(r.survivedMs / 1000)}s, no error)`);
    } finally { await srv.close(); }
  }

  {
    console.log('\nSLOW control: idle stream, keepalive OFF — must DIE at ~300s');
    const srv = await startServer(0);
    try {
      const sid = await initSession(srv.port);
      const r = await surviveIdle(srv.port, sid, WINDOW_MS);
      console.log(`    survived ${Math.round(r.survivedMs / 1000)}s, error=${r.error ?? 'none'}`);
      ok(r.error !== null && r.survivedMs < WINDOW_MS,
        `without keepalive the idle stream died at ${Math.round(r.survivedMs / 1000)}s (${r.error}) — reproduces the reported failure`);
    } finally { await srv.close(); }
  }
} else {
  console.log('\n(skipped the unscaled 300s test + control — set OURS_SLOW_SSE_TEST=1 to run, ~11 min)');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
