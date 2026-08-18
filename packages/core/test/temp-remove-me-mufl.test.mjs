// packages/core/test/temp-remove-me-mufl.test.mjs
// End-to-end best-effort remove-me over REAL packets and a real local broker
// (driver: scripts/test-temp-remove-me-mufl.sh). One daemon, two identities:
// a permanent anchor and a temporary one that connects to it via the local
// contact book, then closes. Proves the core 0.13 bilateral removal actually
// lands (the anchor drops the closed temp identity) and that a broker outage
// never blocks local cleanup.
import { connectConnector } from './fixtures/connector-client.mjs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BROKER_URL = process.env.BROKER_URL;
const BROKER_PID = Number(process.env.BROKER_PID || 0);
if (!BROKER_URL) throw new Error('BROKER_URL is required (run via scripts/test-temp-remove-me-mufl.sh)');

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'dist', 'cli.js');
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓', m)) : (fail++, console.log('  ✗ FAIL:', m)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });

async function connector(_url, token, pid) {
  // `_url` is ignored: the connector is spawned, not dialled, and takes its port
  // and state dir from the env. The token and pid still select the session.
  const c = await connectConnector({ port: PORT, stateDir: dir, leaseToken: token, clientPid: pid });
  return { client: c.client, call: c.call, close: c.close };
}
const text = (r) => (Array.isArray(r.content) ? r.content.map((c) => c.text || '').join(' ') : '');
const isErr = (r) => r.isError === true;
const until = async (fn, ms, step = 1000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return true; if (Date.now() > end) return false; await sleep(step); } };

const dir = mkdtempSync(join(tmpdir(), 'a2a-tempcrm-'));
const PORT = await freePort();
const daemon = spawn('node', [CLI, 'serve'], {
  env: { ...process.env, OURS_TRANSPORT: 'http', OURS_PORT: String(PORT), OURS_STATE_DIR: dir, OURS_BROKER_URL: BROKER_URL, OURS_API_VISIBILITY: 'open' },
  stdio: 'ignore',
});
try {
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/version`)).ok) break; } catch {} await sleep(250); }

  const A = await connector(null, 'tokAnchor', process.pid);
  await A.call('create_identity', { name: 'Anchor' }); // permanent, published in the local book
  const B = await connector(null, 'tokTemp', process.pid);
  const cr = await B.call('create_temporary_identity', {});
  const tmpName = (text(cr).match(/TEMPORARY identity "([^"]+)"/) || [])[1];
  ok(!!tmpName, `temporary identity created (${tmpName})`);

  // Connect over REAL packets: the temp identity messages the published anchor
  // (registrar introduction via the local book), which auto-accepts.
  const sent = await B.call('send_message', { contact: 'Anchor', text: 'hello from a temporary identity' });
  ok(!isErr(sent), 'temp identity reaches the anchor through the local contact book');
  const connected = await until(async () =>
    new RegExp(tmpName).test(text(await A.call('list_contacts', {}))), 60_000);
  ok(connected, 'anchor registered the temp identity as a contact');
  const gotMsg = await until(async () =>
    /hello from a temporary identity/.test(text(await A.call('get_messages', {}))), 30_000);
  ok(gotMsg, 'the message was delivered');

  // Let the new-contact capability advertise settle (scheduleCapabilityReconcile
  // fires at 2s/15s after the contact-add event; the remove-me gate needs the
  // temp side to have LEARNED the anchor's caps before it can emit the notice).
  await sleep(20_000);

  // Close the temp identity: ONE best-effort remove-me per contact, then delete.
  const closed = await B.call('close_temporary_identity', {});
  ok(!isErr(closed) && /closed and all local state deleted/.test(text(closed)), 'temp identity closed');
  ok(/1\/1 queued/.test(text(closed)), `remove-me notice queued for its 1 contact (got: ${text(closed).slice(0, 200)})`);
  ok(!existsSync(join(dir, tmpName)), 'temp identity local state fully deleted');

  // The bilateral half actually lands: the anchor drops the removed contact.
  const dropped = await until(async () =>
    !new RegExp(tmpName).test(text(await A.call('list_contacts', {}))), 60_000);
  ok(dropped, 'anchor dropped the temp identity after its authenticated remove-me notice');

  // Broker outage: closing still deletes locally (remove-me is best effort).
  const C = await connector(null, 'tokTemp2', process.pid);
  const cr2 = await C.call('create_temporary_identity', {});
  const tmp2 = (text(cr2).match(/TEMPORARY identity "([^"]+)"/) || [])[1];
  await C.call('send_message', { contact: 'Anchor', text: 'second temp' });
  await until(async () => new RegExp(tmp2).test(text(await A.call('list_contacts', {}))), 60_000);
  if (BROKER_PID) { try { process.kill(BROKER_PID, 'SIGKILL'); } catch { /* already gone */ } }
  await sleep(1500);
  const closed2 = await C.call('close_temporary_identity', {});
  ok(!isErr(closed2) && /closed and all local state deleted/.test(text(closed2)),
    'with the broker DOWN, close still deletes all local state (unreachable contacts never block cleanup)');
  ok(!existsSync(join(dir, tmp2)), 'second temp identity local state fully deleted despite the outage');

  await A.close().catch(() => {}); await B.close().catch(() => {}); await C.close().catch(() => {});
} finally {
  daemon.kill('SIGTERM');
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\ntemp-remove-me-mufl: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
