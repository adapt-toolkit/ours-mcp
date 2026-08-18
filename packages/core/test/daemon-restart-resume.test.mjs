// daemon-restart-resume — the connector keeps working across a daemon restart.
//
// REWRITTEN, NOT MIGRATED, and two of its five assertions are GONE WITH THEIR
// COMPONENT rather than ported:
//
//   * "(3a) a request in flight when the upstream dies FAILS BACK instead of
//     being silently replayed" tested runProxy's watchdog. There is no in-flight
//     MCP frame to lose: a tool call is one HTTP request, and its failure is its
//     own answer, reported to the caller by the request itself.
//   * "(3c) the connector re-bound the identity itself (synthetic
//     choose_identity replay)" tested runProxy's reconnect. There is nothing to
//     re-bind. The lease token travels on every request and the daemon persists
//     its bindings, so the second daemon already knows this session.
//
// What SURVIVES is the property a user actually has — the agent does not have to
// re-bind after a restart — and it survives in a stronger form: it now holds
// because there is no session to lose, rather than because a shim rebuilt one.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

import { connectConnector, spawnDaemon, waitForDaemon, sleep } from './fixtures/connector-client.mjs';

const T0 = Date.now();
const mark = (...m) => console.log(`  [diag +${((Date.now() - T0) / 1000).toFixed(2)}s]`, ...m);

const freePort = () => new Promise((resolve, reject) => {
  const s = createServer();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓', m)) : (fail++, console.log('  ✗ FAIL:', m)); };
const isOk = (r) => r && r.isError !== true;

const port = await freePort();
const dir = mkdtempSync(join(tmpdir(), 'a2a-restart-'));
let daemon = spawnDaemon(port, dir);
let conn;

try {
  await waitForDaemon(port);

  conn = await connectConnector({ port, stateDir: dir, leaseToken: 'restart-session' });
  const created = await conn.call('create_identity', { name: 'Dora', expose_local: false });
  ok(isOk(created), '(1) create_identity Dora succeeds (also binds it)');
  ok(isOk(await conn.call('get_messages')), '(2) get_messages works on the first daemon');

  // ── the daemon dies and comes back on the same port and state dir ─────────
  mark('killing daemon 1, pid', daemon.pid);
  daemon.kill('SIGKILL');
  await sleep(500);
  mark('spawning daemon 2 on port', port);
  daemon = spawnDaemon(port, dir);
  await waitForDaemon(port);
  mark('daemon 2 answered /version');
  try {
    const v = await (await fetch(`http://127.0.0.1:${port}/version`)).text();
    mark('/version body:', v.slice(0, 200));
  } catch (e) { mark('/version re-read threw:', String(e)); }

  // The connector is ALIVE throughout and made no bind call of any kind.
  const gm = await conn.call('get_messages');
  mark('get_messages ->', JSON.stringify(gm).slice(0, 900));
  ok(isOk(gm) && !/No identity bound/i.test(JSON.stringify(gm)),
    '(3) the SAME connector works against the SECOND daemon with no choose_identity');

  const ci = await conn.call('current_identity');
  mark('current_identity ->', JSON.stringify(ci).slice(0, 900));
  const li = await conn.call('list_identities');
  mark('list_identities ->', JSON.stringify(li).slice(0, 900));
  const cx = await conn.call('choose_identity', { name: 'Dora' });
  mark('explicit choose_identity ->', JSON.stringify(cx).slice(0, 900));
  ok(isOk(ci) && /Dora/.test(JSON.stringify(ci)),
    '(4) current_identity is still Dora after the daemon restart');
} finally {
  try { if (conn) await conn.close(); } catch { /* already gone */ }
  try { daemon.kill('SIGKILL'); } catch { /* already gone */ }
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
