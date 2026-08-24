// proxy-dead-stderr — the survival handlers must not announce survival into the
// channel that just failed.
//
// THE DEFECT. Both process-level handlers logged "(proxy stays up)" to stderr:
//
//   process.on('uncaughtException', (err) => log('UNCAUGHT EXCEPTION (proxy stays up):', …))
//
// stderr is a pipe owned by the client. When the client dies the pipe dies, and a
// write to it fails asynchronously — as an 'error' event that Node converts into
// an uncaughtException. The handler then called log() to report it, that write
// failed too, and the loop closed on itself.
//
// MEASURED, ours-mcp 0.16.0, four variants terminated identically by stdin EOF and
// differing ONLY in where stdout/stderr pointed:
//
//   stdout=file  stderr=file  → idle, 55 jiffies / 111 s, upstream socket healthy
//   stdout=file  stderr=DEAD  → spins ~100% of a core from ~96 s
//   stdout=DEAD  stderr=file  → idle, 56 jiffies / 181 s, upstream socket healthy
//   stdout=DEAD  stderr=DEAD  → spins ~100% of a core from ~73 s
//
// stderr is the discriminator; stdout is irrelevant. The handler written to
// prevent a silent death was the thing burning the CPU.
//
// THE RULE THIS PINS. A failed write to stderr is never reported via stderr. The
// modular adapter may have nothing to write while the SDK reconnects internally;
// in that case it remains idle and can still answer over stdin/stdout. If a write
// does observe the broken channel it exits, and in neither case may it spin.
//
// This test deliberately keeps stdin OPEN so it cannot pass by accident on the
// stdin-EOF exit path — it isolates the stdio-write door specifically.
//
// Run after build.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

async function startQuietDaemon(stateDir) {
  const held = [];
  let sessionId = null;
  const srv = createServer(async (req, res) => {
    if (req.url === '/state-dir') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ stateDir, version: '0.0.0-test', compat: 1 }));
      return;
    }
    if (req.url !== '/mcp') { res.writeHead(404); res.end(); return; }
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      held.push(res);
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
    // Killing the daemon is how we make the proxy WANT to log: every failed
    // reconnect writes a line, so a dead stderr is exercised repeatedly.
    close: () => { for (const r of held) { try { r.destroy(); } catch { /* gone */ } } return new Promise((r) => srv.close(r)); },
  };
}

function startProxy(port, dir) {
  const p = spawn('node', [CLI, 'proxy'], {
    env: {
      ...process.env,
      // Never inherit a supervisor's OURS_BIND_IDENTITY: an ours-fleet-managed host
      // exports it, and it would seed a startup bind these cases never asked for
      // (that input has its own suite — env-bind-identity.test.mjs).
      OURS_BIND_IDENTITY: undefined,
      OURS_PORT: String(port), OURS_STATE_DIR: dir,
      OURS_API_VISIBILITY: 'open',
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
  const exited = new Promise((res) => p.on('exit', (code, sig) => res({ code, sig })));
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

// CPU actually burned by a pid, in jiffies, from /proc. Linux-only; elsewhere the
// exit assertion alone carries the test.
function jiffies(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return Number(after[11]) + Number(after[12]); // utime + stime
  } catch { return null; }
}

console.log('proxy-dead-stderr\n');

{
  console.log('stderr dies while stdin stays open → proxy exits or stays idle, never spins');
  const dir = mkdtempSync(join(tmpdir(), 'ours-stderr-'));
  const daemon = await startQuietDaemon(dir);
  const px = startProxy(daemon.port, dir);
  try {
    px.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'stderr-test', version: '0' } } });
    ok(Boolean(await waitFor(px.frames, (f) => f.id === 1 && f.result, 15000)), 'proxy completed the handshake');
    px.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await sleep(500);

    const before = jiffies(px.proc.pid);

    // Kill ONLY stderr. stdin stays open, so the stdin-EOF exit path cannot fire
    // and anything we observe is attributable to the write channel alone.
    px.proc.stderr.destroy();
    // Now give it a reason to write: with the daemon gone, every reconnect
    // attempt logs. Under the defect this is where the loop took off.
    await daemon.close();

    const outcome = await Promise.race([px.exited, sleep(20000).then(() => null)]);
    if (outcome) {
      ok(true, 'proxy exited after observing the broken diagnostic channel');
    } else if (before !== null) {
      // The SDK owns reconnects and may emit no adapter log, leaving the broken
      // pipe unobserved. It may stay alive while stdin/stdout remain usable, but
      // it must remain idle. 20s at a full core is roughly 2000 jiffies.
      const after = jiffies(px.proc.pid);
      const burned = after === null ? null : after - before;
      ok(burned !== null && burned < 200,
        `proxy did not spin on the unobserved dead stderr (${burned} jiffies over 20s; a full core would be ~2000)`);
    } else {
      ok(true, 'proxy remained available and this host has no /proc CPU accounting');
    }
  } finally { px.kill(); rmSync(dir, { recursive: true, force: true }); }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
