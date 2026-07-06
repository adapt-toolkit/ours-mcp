// port-visibility — Part B: daemon HTTP port cross-user visibility is
// configurable, DEFAULT owner-only (loopback bind + bearer token).
//
// The port stays on 127.0.0.1 (reachable by any local OS user at TCP level),
// but the messaging + notification surface requires a token:
//   owner  (DEFAULT) — token auto-generated to an owner-only 0600 file; only
//                      the daemon owner can read it → same-user-only.
//   shared           — token MUST be operator-supplied (OURS_API_TOKEN / config)
//                      so the fleet can distribute it; refuse to start otherwise.
//   open             — no token; all local users (legacy behavior, opt-in).
//
// Liveness/introspection (/version, /state-dir) stay UNAUTHENTICATED in every
// mode (they leak no messages and let `ours-mcp status` / portOpen probe).
//
// Self-contained: spawns the BUILT daemon. Run after `npm run build`.

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'dist', 'cli.js');
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓', m)) : (fail++, console.log('  ✗ FAIL:', m)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

const INIT_BODY = JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } },
});

function startDaemon(port, dir, extraEnv) {
  return spawn('node', [CLI, 'serve'], {
    env: { ...process.env, OURS_TRANSPORT: 'http', OURS_PORT: String(port), OURS_STATE_DIR: dir, OURS_BROKER_URL: 'ws://127.0.0.1:59997/nobroker', ...extraEnv },
    stdio: 'ignore', detached: true,
  });
}
async function waitVersion(port, maxMs = 30_000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/version`)).ok) return true; } catch { /* not yet */ }
    await sleep(250);
  }
  return false;
}
const kill = (d) => { try { process.kill(-d.pid, 'SIGKILL'); } catch { /* gone */ } };

console.log('port-visibility\n');

// ─── owner (default): token required on the messaging/notification surface ───
{
  const dir = mkdtempSync(join(tmpdir(), 'a2a-vis-owner-'));
  const PORT = await freePort();
  const d = startDaemon(PORT, dir, {}); // no visibility set → DEFAULT owner
  try {
    const up = await waitVersion(PORT);
    ok(up, '(owner) daemon boots under DEFAULT visibility');
    if (up) {
      // /version stays unauthenticated (liveness).
      const ver = await fetch(`http://127.0.0.1:${PORT}/version`);
      ok(ver.status === 200, '(owner) /version is unauthenticated (200)');

      // The owner reads the auto-generated 0600 token file.
      const token = readFileSync(join(dir, 'daemon-token'), 'utf8').trim();
      ok(token.length >= 32, '(owner) token auto-generated to 0600 daemon-token file');

      // Protected surface without a token → 401 (not a hang).
      const noAuth = await fetch(`http://127.0.0.1:${PORT}/identities`);
      ok(noAuth.status === 401, '(owner) GET /identities without token → 401');

      const mcpNoAuth = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: INIT_BODY,
      });
      ok(mcpNoAuth.status === 401, '(owner) POST /mcp without token → 401');

      // With the token → allowed.
      const withAuth = await fetch(`http://127.0.0.1:${PORT}/identities`, { headers: { 'x-ours-api-token': token } });
      ok(withAuth.status === 200, '(owner) GET /identities WITH token → 200');

      // A WRONG token → 401.
      const badAuth = await fetch(`http://127.0.0.1:${PORT}/identities`, { headers: { 'x-ours-api-token': 'nope' } });
      ok(badAuth.status === 401, '(owner) GET /identities with WRONG token → 401');
    }
  } finally { kill(d); rmSync(dir, { recursive: true, force: true }); }
}

// ─── open: legacy behavior, no token required ────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'a2a-vis-open-'));
  const PORT = await freePort();
  const d = startDaemon(PORT, dir, { OURS_API_VISIBILITY: 'open' });
  try {
    ok(await waitVersion(PORT), '(open) daemon boots');
    const noAuth = await fetch(`http://127.0.0.1:${PORT}/identities`);
    ok(noAuth.status === 200, '(open) GET /identities without token → 200 (legacy open)');
  } finally { kill(d); rmSync(dir, { recursive: true, force: true }); }
}

// ─── shared without an operator token: MUST refuse to start ──────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'a2a-vis-shared-notok-'));
  const PORT = await freePort();
  const d = startDaemon(PORT, dir, { OURS_API_VISIBILITY: 'shared' }); // no OURS_API_TOKEN
  let exitCode = null;
  d.on('exit', (c) => { exitCode = c; });
  try {
    const up = await waitVersion(PORT, 6000);
    ok(!up, '(shared/no-token) daemon does NOT open the port');
    await sleep(500);
    ok(exitCode !== null && exitCode !== 0, '(shared/no-token) daemon exits non-zero (refuses to start)');
  } finally { kill(d); rmSync(dir, { recursive: true, force: true }); }
}

// ─── shared WITH an operator token: cross-user path, still authenticated ─────
{
  const dir = mkdtempSync(join(tmpdir(), 'a2a-vis-shared-'));
  const PORT = await freePort();
  const TOKEN = 'fleet-shared-secret-token-abcdef0123456789';
  const d = startDaemon(PORT, dir, { OURS_API_VISIBILITY: 'shared', OURS_API_TOKEN: TOKEN });
  try {
    ok(await waitVersion(PORT), '(shared) daemon boots with operator token');
    const noAuth = await fetch(`http://127.0.0.1:${PORT}/identities`);
    ok(noAuth.status === 401, '(shared) GET /identities without token → 401');
    const withAuth = await fetch(`http://127.0.0.1:${PORT}/identities`, { headers: { 'x-ours-api-token': TOKEN } });
    ok(withAuth.status === 200, '(shared) GET /identities WITH distributed token → 200');
  } finally { kill(d); rmSync(dir, { recursive: true, force: true }); }
}

console.log(`\n${pass}/${pass + fail} passed${fail ? ` (${fail} FAILED)` : ''}`);
process.exit(fail === 0 ? 0 : 1);
