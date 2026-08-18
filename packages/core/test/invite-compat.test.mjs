// packages/core/test/invite-compat.test.mjs
//
// INVITE COMPATIBILITY GATE (owner requirement: "the hash changes, but invites
// must not break") — cross-release, both directions, full stack.
//
// OLD peer: the PUBLISHED @ours.network/mcp release artifact — the genuine
//   shipped bytes a real peer in the wild is running (dist/cli.js + its
//   compiled .muflo), installed into its own prefix with its own node_modules.
//   Point OLD_OURS_DIR at that install (see scripts/test-invite-compat.sh).
// NEW peer: THIS working tree's build (packages/core/dist).
//
// Two separate daemon processes on one local dev broker. For each direction:
// generate_invite on one side, add_contact on the other, assert the contact
// registered on BOTH sides, then send a first message EACH WAY and assert the
// recipient actually read it (get_messages) — delivery, not just tool success.
//
// Not part of the npm chain: it needs the released artifact on disk. Run via
// scripts/test-invite-compat.sh.
import { connectConnector } from './fixtures/connector-client.mjs';
// The OLD peer is a published release that still hosts /mcp — an MCP client is the
// only way into it. The NEW peer has no /mcp at all. See bootDaemon.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const NEW_CLI = join(HERE, '..', 'dist', 'cli.js');
const OLD_DIR = process.env.OLD_OURS_DIR;
if (!OLD_DIR) throw new Error('OLD_OURS_DIR is required (an npm-installed released @ours.network/mcp package dir)');
const OLD_CLI = resolve(OLD_DIR, 'dist', 'cli.js');
const BROKER = join(HERE, '..', '..', '..', 'scripts', 'dev-broker.mjs');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓', m)) : (fail++, console.log('  ✗ FAIL:', m)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
const txt = (r) => (Array.isArray(r.content) ? r.content : []).map((c) => (typeof c.text === 'string' ? c.text : '')).join('\n');
const withTimeout = (p, ms, what) => Promise.race([p, sleep(ms).then(() => { throw new Error(`${what} timed out after ${ms}ms`); })]);
const unitHashOf = (dir) => readdirSync(dir).find((f) => f.endsWith('.muflo'))?.slice(0, 12);

const oldState = mkdtempSync(join(tmpdir(), 'a2a-compat-old-'));
const newState = mkdtempSync(join(tmpdir(), 'a2a-compat-new-'));
const BPORT = await freePort();
const broker = spawn('node', [BROKER, '--host', '127.0.0.1', '--port', String(BPORT), '--test_mode'], { stdio: 'ignore' });
await sleep(2000);

// ⚠ THE TWO PEERS SPEAK DIFFERENT PROTOCOLS, AND THAT IS THE TEST.
// `side: "old"` is a PUBLISHED release artifact: it still hosts /mcp and an MCP
// client is the only way in. `side: "new"` is this tree, which hosts no MCP server
// at all — its tools are reached by spawning the connector. Do not "unify" these.
async function bootDaemon(cli, state, cwd, side) {
  const port = await freePort();
  const proc = spawn('node', [cli, 'serve'], {
    cwd,
    env: { ...process.env, OURS_TRANSPORT: 'http', OURS_PORT: String(port), OURS_STATE_DIR: state, OURS_BROKER_URL: `ws://127.0.0.1:${BPORT}`, OURS_API_VISIBILITY: 'open' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/version`)).ok) break; } catch {} await sleep(250); }
  const version = await fetch(`http://127.0.0.1:${port}/version`).then((r) => r.json()).catch(() => ({}));
  let client;
  let transport;
  let closeClient;
  if (side === 'new') {
    const conn = await connectConnector({ port, stateDir: state, leaseToken: `compat-${port}` });
    client = conn.client;
    closeClient = conn.close;
  } else {
    transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { 'x-ours-lease-token': `compat-${port}`, 'x-ours-client-pid': String(process.pid) } },
    });
    client = new Client({ name: `compat-${port}`, version: '0.0.0' });
    await client.connect(transport);
    closeClient = async () => {
      try { await transport.terminateSession(); } catch { /* ignore */ }
      try { await client.close(); } catch { /* ignore */ }
    };
  }
  const call = async (name, args = {}) => {
    const r = await withTimeout(client.callTool({ name, arguments: args }), 30_000, name);
    return { text: txt(r), isError: !!r.isError };
  };
  return { proc, call, client, transport, closeClient, version };
}

const blobOf = (invText) => {
  const m = invText.match(/:\s*\n\n([^\s]+)\s*$/);
  if (!m) throw new Error(`could not extract invite blob from:\n${invText}`);
  return m[1];
};
// Poll get_messages until the marker arrives (delivery proof, not tool success).
async function receives(call, marker, ms = 20_000) {
  const deadline = Date.now() + ms;
  let seen = '';
  for (;;) {
    const r = await call('get_messages');
    seen += r.text;
    if (seen.includes(marker)) return true;
    if (Date.now() > deadline) { console.error(`    [last get_messages]: ${r.text}`); return false; }
    await sleep(1000);
  }
}

let oldD, newD;
try {
  oldD = await bootDaemon(OLD_CLI, oldState, OLD_DIR, 'old');
  newD = await bootDaemon(NEW_CLI, newState, undefined, 'new');
  console.log(`  OLD daemon: v${oldD.version.version ?? '?'} unit ${unitHashOf(resolve(OLD_DIR, 'dist', 'mufl_code'))}… (published npm artifact)`);
  console.log(`  NEW daemon: v${newD.version.version ?? '?'} unit ${unitHashOf(join(HERE, '..', 'dist', 'mufl_code'))}… (this branch)`);

  await oldD.call('create_identity', { name: 'OldPeer', expose_local: false });
  await newD.call('create_identity', { name: 'NewPeer', expose_local: false });

  // ---- direction 1: OLD generates, NEW redeems ---------------------------
  const inv1 = (await oldD.call('generate_invite', { name: 'NewPeer' }));
  ok(!inv1.isError, 'OLD (released) generates an invite');
  const add1 = await newD.call('add_contact', { invite: blobOf(inv1.text), name: 'OldPeer' });
  ok(!add1.isError, 'NEW (this branch) redeems the OLD invite without error');
  await sleep(5000);
  ok(/NewPeer/.test((await oldD.call('list_contacts')).text), 'OLD registered NewPeer (handshake leg 2 accepted)');
  ok(/OldPeer/.test((await newD.call('list_contacts')).text), 'NEW registered OldPeer (handshake leg 3 accepted)');
  const m1 = await newD.call('send_message', { contact: 'OldPeer', text: 'probe NEW->OLD after OLD-minted invite' });
  ok(!m1.isError, 'NEW sends the first message');
  ok(await receives(oldD.call, 'probe NEW->OLD after OLD-minted invite'), 'OLD RECEIVED it (read via get_messages)');
  const m2 = await oldD.call('send_message', { contact: 'NewPeer', text: 'probe OLD->NEW after OLD-minted invite' });
  ok(!m2.isError, 'OLD sends the reply');
  ok(await receives(newD.call, 'probe OLD->NEW after OLD-minted invite'), 'NEW RECEIVED it (read via get_messages)');

  // ---- direction 2: NEW generates, OLD redeems ---------------------------
  await oldD.call('create_identity', { name: 'OldPeer2', expose_local: false });
  await newD.call('create_identity', { name: 'NewPeer2', expose_local: false });
  const inv2 = (await newD.call('generate_invite', { name: 'OldPeer2' }));
  ok(!inv2.isError, 'NEW (this branch) generates an invite');
  const add2 = await oldD.call('add_contact', { invite: blobOf(inv2.text), name: 'NewPeer2' });
  ok(!add2.isError, 'OLD (released) redeems the NEW invite without error');
  await sleep(5000);
  ok(/OldPeer2/.test((await newD.call('list_contacts')).text), 'NEW registered OldPeer2 (handshake leg 2 accepted)');
  ok(/NewPeer2/.test((await oldD.call('list_contacts')).text), 'OLD registered NewPeer2 (handshake leg 3 accepted)');
  const m3 = await oldD.call('send_message', { contact: 'NewPeer2', text: 'probe OLD->NEW after NEW-minted invite' });
  ok(!m3.isError, 'OLD sends the first message');
  ok(await receives(newD.call, 'probe OLD->NEW after NEW-minted invite'), 'NEW RECEIVED it (read via get_messages)');
  const m4 = await newD.call('send_message', { contact: 'OldPeer2', text: 'probe NEW->OLD after NEW-minted invite' });
  ok(!m4.isError, 'NEW sends the reply');
  ok(await receives(oldD.call, 'probe NEW->OLD after NEW-minted invite'), 'OLD RECEIVED it (read via get_messages)');
} catch (err) {
  fail += 1;
  console.error('  ✗ SUITE ERROR:', err);
} finally {
  for (const d of [oldD, newD]) {
    if (!d) continue;
    try { await d.closeClient(); } catch { /* already gone */ }
    d.proc.kill('SIGTERM');
  }
  broker.kill('SIGTERM');
  await sleep(1000);
  rmSync(oldState, { recursive: true, force: true });
  rmSync(newState, { recursive: true, force: true });
}
console.log(`\ninvite compatibility (published release <-> this branch): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
