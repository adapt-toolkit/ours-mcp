// packages/core/test/temp-identities.test.mjs
// Temporary (session-scoped) identities: creation (explicit/random name,
// collisions), ownership fail-closed enforcement, visibility, idempotent close
// with full local-state deletion, permanent-identity protection, and the
// daemon-restart behaviors (live owner survives; stale owner + orphan dirs are
// reclaimed by the boot sweep). Offline (invalid broker) — remove-me delivery
// is covered by scripts/test-temp-remove-me-mufl.sh.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'dist', 'cli.js');
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓', m)) : (fail++, console.log('  ✗ FAIL:', m)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });

async function connector(url, token, pid) {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { 'x-ours-lease-token': token, 'x-ours-client-pid': String(pid) } },
  });
  const client = new Client({ name: `c-${token}`, version: '0.0.0' });
  await client.connect(transport);
  return {
    client,
    call: (name, args = {}) => client.callTool({ name, arguments: args }),
    close: async () => { await transport.terminateSession(); await client.close(); },
  };
}
const text = (r) => (Array.isArray(r.content) ? r.content.map((c) => c.text || '').join(' ') : '');
const isErr = (r) => r.isError === true;

const dir = mkdtempSync(join(tmpdir(), 'a2a-temp-'));
const PORT = await freePort();
const URL_ = `http://127.0.0.1:${PORT}/mcp`;
const env = { ...process.env, OURS_TRANSPORT: 'http', OURS_PORT: String(PORT), OURS_STATE_DIR: dir, OURS_BROKER_URL: 'wss://invalid.local/none', OURS_API_VISIBILITY: 'open' };
const startDaemon = () => spawn('node', [CLI, 'serve'], { env, stdio: 'ignore' });
const waitUp = async () => { for (let i = 0; i < 120; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/version`)).ok) return; } catch {} await sleep(250); } throw new Error('daemon did not come up'); };
const stopDaemon = (d) => new Promise((r) => { d.on('exit', r); d.kill('SIGTERM'); });

let daemon = startDaemon();
try {
  await waitUp();
  // A pid we know is DEAD (for the synthetic stale-owner scenarios).
  const corpse = spawn('node', ['-e', 'process.exit(0)']);
  const deadPid = corpse.pid;
  await new Promise((r) => corpse.on('exit', r));

  const A = await connector(URL_, 'tokA', process.pid);

  // --- creation --------------------------------------------------------------
  const cr = await A.call('create_temporary_identity', { name: 'Scratch' });
  ok(!isErr(cr) && /TEMPORARY identity "Scratch"/.test(text(cr)), 'explicit name preserved on creation');
  ok(/bound it to this session/.test(text(cr)), 'creation auto-binds the owning session');
  ok(/best-effort remove-me/.test(text(cr)), 'creation result states the best-effort remove-me semantics');
  const marker = join(dir, 'Scratch', 'temp.json');
  ok(existsSync(marker), 'temp.json ownership marker persisted');
  ok((statSync(marker).mode & 0o777) === 0o600, 'temp.json is 0600');
  const meta = JSON.parse(readFileSync(marker, 'utf8'));
  ok(meta.v === 1 && typeof meta.owner?.pid === 'number', 'marker carries owner pid');
  ok(typeof meta.owner?.token_sha256 === 'string' && !JSON.stringify(meta).includes('tokA'), 'marker stores a token HASH, never the raw lease token');

  const dup = await A.call('create_temporary_identity', { name: 'Scratch' });
  ok(isErr(dup) && /already exists/.test(text(dup)), 'explicit-name collision with an existing identity is refused');

  const B = await connector(URL_, 'tokB', process.pid);
  const rnd = await B.call('create_temporary_identity', {});
  const rndName = (text(rnd).match(/TEMPORARY identity "([^"]+)"/) || [])[1];
  ok(!isErr(rnd) && /^tmp-[0-9a-f]{10}$/.test(rndName || ''), `omitted name generates a public-safe random one (${rndName})`);

  // --- visibility ------------------------------------------------------------
  const listA = text(await A.call('list_identities', {}));
  ok(/Scratch[^\n]*\[temporary — owned by THIS session\]/.test(listA), 'list_identities tags A\'s temp as owned by THIS session');
  ok(new RegExp(`${rndName}[^\\n]*temporary — owned by another live session`).test(listA), 'list_identities tags B\'s temp as owned by another live session');
  const cur = text(await A.call('current_identity', {}));
  ok(/TEMPORARY identity owned by this session/.test(cur), 'current_identity reports the temporary, session-scoped lifetime');
  const http = await fetch(`http://127.0.0.1:${PORT}/identities`).then((r) => r.json());
  const httpScratch = http.identities.find((i) => i.name === 'Scratch');
  ok(httpScratch?.temporary === true && httpScratch?.stale === false, 'GET /identities exposes temporary:true, stale:false');

  // --- ownership: fail closed ------------------------------------------------
  ok(isErr(await B.call('choose_identity', { name: 'Scratch' })), 'another session cannot bind a live-owned temp identity');
  const forceTry = await B.call('choose_identity', { name: 'Scratch', force: true });
  ok(isErr(forceTry) && /cannot be overridden/.test(text(forceTry)), 'force does NOT override a live owner (fail closed)');
  const closeTry = await B.call('close_temporary_identity', { name: 'Scratch' });
  ok(isErr(closeTry) && /another LIVE session/.test(text(closeTry)), 'another session cannot close a live-owned temp identity');
  const rmTry = await B.call('remove_identity', { name: 'Scratch' });
  ok(isErr(rmTry) && /another LIVE session/.test(text(rmTry)), 'another session cannot remove_identity a live-owned temp identity');

  // --- close: permanent protection + idempotency + full local deletion -------
  await A.call('create_identity', { name: 'Perm', expose_local: false }); // becomes host root; A switches to it
  const closePerm = await A.call('close_temporary_identity', { name: 'Perm' });
  ok(isErr(closePerm) && /permanent identity/.test(text(closePerm)), 'close_temporary_identity refuses a permanent identity');

  await A.call('choose_identity', { name: 'Scratch' }); // owner re-binds its own temp
  const closed = await A.call('close_temporary_identity', {});
  ok(!isErr(closed) && /closed and all local state deleted/.test(text(closed)), 'owner closes its bound temp identity');
  ok(/no contacts/.test(text(closed)), 'close reports the (empty) per-contact notice counts');
  ok(!existsSync(join(dir, 'Scratch')), 'the identity dir (keys, state, inbox, files, marker) is gone');
  ok(!/Scratch/.test(text(await A.call('list_identities', {}))), 'closed temp identity left the listings');
  const again = await A.call('close_temporary_identity', { name: 'Scratch' });
  ok(!isErr(again) && /nothing to close/.test(text(again)), 'closing an already-gone temp identity is an idempotent no-op');
  const recreate = await A.call('create_temporary_identity', { name: 'Scratch' });
  ok(!isErr(recreate), 'the name is free again after close');
  await A.call('close_temporary_identity', {});

  // remove_identity routes a temp identity through the same lifecycle close.
  await B.call('choose_identity', { name: rndName });
  const rmOwn = await B.call('remove_identity', { name: rndName });
  ok(!isErr(rmOwn) && /Removed temporary identity/.test(text(rmOwn)), 'remove_identity closes an owned temp identity via the lifecycle path');
  ok(!existsSync(join(dir, rndName)), 'its state dir is gone too');

  // --- restart: live owner survives, stale owner + orphan dir are reclaimed --
  const LIVE = spawn('node', ['-e', 'setInterval(()=>{},1e9)']); // a client that stays alive
  const C = await connector(URL_, 'tokC', LIVE.pid);
  await C.call('create_temporary_identity', { name: 'Survivor' });
  const D = await connector(URL_, 'tokD', deadPid);
  await D.call('create_temporary_identity', { name: 'Doomed' });
  await A.call('choose_identity', { name: 'Perm' });
  // An orphaned dir: marker but no identity.key (simulates a crash mid-provision).
  const orphanDir = join(dir, 'orphan-tmp');
  mkdirSync(orphanDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(orphanDir, 'temp.json'), JSON.stringify({ v: 1, owner: { token_sha256: 'ab'.repeat(32), pid: deadPid }, created_at: Date.now() }), { mode: 0o600 });

  await stopDaemon(daemon);
  daemon = startDaemon();
  await waitUp();
  await sleep(1500); // boot sweeps run after the restore loop

  const names = readdirSync(dir);
  ok(names.includes('Survivor'), 'restart: temp identity with a LIVE owner survives');
  ok(!names.includes('Doomed'), 'restart: temp identity with a DEAD owner is swept by the boot reclaim');
  ok(!names.includes('orphan-tmp'), 'restart: orphaned temp dir (no key, dead owner) is swept');
  ok(names.includes('Perm'), 'restart: the permanent identity is untouched by every sweep');

  const C2 = await connector(URL_, 'tokC', LIVE.pid);
  ok(!isErr(await C2.call('choose_identity', { name: 'Survivor' })), 'restart: the owner re-binds its surviving temp identity');
  const E = await connector(URL_, 'tokE', process.pid);
  const staleHttp = await fetch(`http://127.0.0.1:${PORT}/identities`).then((r) => r.json());
  ok(staleHttp.identities.some((i) => i.name === 'Survivor' && i.temporary === true), 'restart: GET /identities still marks Survivor temporary');

  // Kill the owner; the stale identity is refusable for bind but reclaimable via close.
  LIVE.kill('SIGKILL'); await new Promise((r) => LIVE.on('exit', r));
  const staleBind = await E.call('choose_identity', { name: 'Survivor', force: true });
  ok(isErr(staleBind) && /STALE/.test(text(staleBind)), 'a stale temp identity cannot be adopted by another session (even force)');
  const reclaim = await E.call('close_temporary_identity', { name: 'Survivor' });
  ok(!isErr(reclaim) && /closed and all local state deleted/.test(text(reclaim)), 'a stale temp identity IS reclaimable via close_temporary_identity');
  ok(!existsSync(join(dir, 'Survivor')), 'reclaimed identity fully deleted');

  await A.close().catch(() => {}); await B.close().catch(() => {}); await C2.close().catch(() => {}); await E.close().catch(() => {});
} finally {
  daemon.kill('SIGTERM');
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\ntemp-identities: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
