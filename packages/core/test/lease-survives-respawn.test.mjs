// test/lease-survives-respawn.test.mjs
//
// Does a respawned connector keep its identity binding without re-binding?
//
// This decides whether the proxy's session-restore mechanism — a 0600 record of
// {identity} keyed by CLAUDE_CODE_SESSION_ID, a TTL, a prune sweep and a
// fail-closed re-assert on boot — is still needed. It existed because the old
// proxy re-sent `initialize` on a cold wake-up, minting a NEW MCP session id,
// and the daemon keyed the binding to that id. Over /api/v1 there is no MCP
// session: the daemon derives its session from a hash of the lease token.
//
// If the binding survives a respawn on the token alone, the record is dead weight
// AND a stored "which identity this session had" file that outlives its reason.
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';

import { connectConnector, spawnDaemon, waitForDaemon } from './fixtures/connector-client.mjs';

const freePort = () => new Promise((resolve, reject) => {
  const s = createServer();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

const port = await freePort();
const stateDir = mkdtempSync(join(tmpdir(), 'ours-respawn-'));
const daemon = spawnDaemon(port, stateDir);

let failures = 0;
const ok = (cond, what) => { if (cond) console.log(`  ok  ${what}`); else { failures++; console.log(`  FAIL ${what}`); } };

const SESSION = 'session-aaaa-bbbb';
const OTHER = 'session-cccc-dddd';

try {
  await waitForDaemon(port);

  // ── 1. first connector: bind an identity ──────────────────────────────────
  const first = await connectConnector({ port, stateDir, leaseToken: SESSION });
  const created = first.txt(await first.call('create_identity', { name: 'Ana', expose_local: false }));
  ok(/Ana/.test(created), `create_identity binds Ana (${created.slice(0, 60)}…)`);
  const boundFirst = first.txt(await first.call('current_identity'));
  ok(/Ana/.test(boundFirst), 'the first connector is bound to Ana');

  // ── 2. the connector goes away, exactly as an idle harness wake-up does ────
  await first.close();

  // ── 3. respawn with the SAME lease token, and make NO bind call ────────────
  const second = await connectConnector({ port, stateDir, leaseToken: SESSION });
  const boundSecond = second.txt(await second.call('current_identity'));
  ok(/Ana/.test(boundSecond),
    `a respawned connector with the same lease token is STILL BOUND, with no re-bind call (${boundSecond.slice(0, 60)}…)`);

  // ── 4. and the binding is the TOKEN's, not the machine's ──────────────────
  // The control that makes assertion 3 mean something: a connector with a
  // DIFFERENT token on the same host, same state dir, must NOT inherit the
  // binding. Without this, "still bound" could just mean "bound to whatever the
  // daemon last saw".
  const other = await connectConnector({ port, stateDir, leaseToken: OTHER });
  const boundOther = other.txt(await other.call('current_identity'));
  ok(!/Bound to "Ana"/.test(boundOther),
    `a different lease token is a different session and is NOT bound (${boundOther.slice(0, 60)}…)`);
  await other.close();
  await second.close();

  // ── 5. no session-restore record was written, and none is needed ──────────
  const restoreDir = join(stateDir, 'session-restore');
  ok(!existsSync(restoreDir) || readdirSync(restoreDir).length === 0,
    'the connector wrote no session-restore record — the lease token is the whole mechanism');
} finally {
  try { daemon.kill('SIGKILL'); } catch { /* already gone */ }
  rmSync(stateDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`\nlease-survives-respawn FAILED (${failures})`);
  process.exit(1);
}
console.log('\nlease-survives-respawn OK (binding follows the lease token across a respawn; no restore record needed)');
process.exit(0);
