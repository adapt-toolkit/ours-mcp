// packages/core/test/contact-uniqueness-daemon.test.mjs
//
// Contact-name uniqueness (SPEC.md, owner decisions D1–D4) — daemon-level suite.
// Drives the BUILT daemon's MCP tools over loopback HTTP against a REAL local
// dev broker, so invite handshakes, sibling introductions and renames run the
// full wire path (the same path the Coordinator incident took).
//
// Grows with the spec phases:
//   Phase 1 — rename_contact: refuse a taken name; rename by container id;
//             the established channel survives a rename (send still delivers).
//
// Standalone run (from packages/core):  node test/contact-uniqueness-daemon.test.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'dist', 'cli.js');
const BROKER = join(HERE, '..', '..', '..', 'scripts', 'dev-broker.mjs');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓', m)) : (fail++, console.log('  ✗ FAIL:', m)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// OS-assigned ports only — never a fixed port (a fixed port can hit a live daemon).
const freePort = () => new Promise((res, rej) => { const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
const txt = (r) => (Array.isArray(r.content) ? r.content : []).map((c) => (typeof c.text === 'string' ? c.text : '')).join('\n');
const withTimeout = (p, ms, what) => Promise.race([p, sleep(ms).then(() => { throw new Error(`${what} timed out after ${ms}ms`); })]);

const dir = mkdtempSync(join(tmpdir(), 'a2a-uniq-'));
const BPORT = await freePort();
const broker = spawn('node', [BROKER, '--host', '127.0.0.1', '--port', String(BPORT), '--test_mode'], { stdio: 'ignore' });
await sleep(2000);
const PORT = await freePort();
const daemon = spawn('node', [CLI, 'serve'], {
  env: { ...process.env, OURS_TRANSPORT: 'http', OURS_PORT: String(PORT), OURS_STATE_DIR: dir, OURS_BROKER_URL: `ws://127.0.0.1:${BPORT}`, OURS_API_VISIBILITY: 'open' },
  stdio: 'ignore',
});

const clients = [];
// One MCP client per identity (each with its own lease token) — no rebinding.
async function mkClient(tag) {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
    requestInit: { headers: { 'x-ours-lease-token': `uniq-${tag}-${PORT}`, 'x-ours-client-pid': String(process.pid) } },
  });
  const client = new Client({ name: `uniq-${tag}`, version: '0.0.0' });
  await client.connect(transport);
  clients.push({ client, transport });
  // Returns the full text; callers inspect r.isError via the second element.
  return async (name, args = {}) => {
    const r = await withTimeout(client.callTool({ name, arguments: args }), 30_000, `${tag}:${name}`);
    return { text: txt(r), isError: !!r.isError };
  };
}
const blobOf = (invText) => {
  const m = invText.match(/:\s*\n\n([^\s]+)\s*$/);
  if (!m) throw new Error(`could not extract invite blob from:\n${invText}`);
  return m[1];
};
const cidOf = (text, name) => text.match(new RegExp(`"?${name}"?[^0-9A-F]*?([0-9A-F]{64})`))?.[1] ?? null;

try {
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/version`)).ok) break; } catch {} await sleep(250); }

  const hub = await mkClient('hub');
  const ann = await mkClient('ann');
  const ben = await mkClient('ben');

  await hub('create_identity', { name: 'Hub', expose_local: false });
  const annCreate = (await ann('create_identity', { name: 'Ann', expose_local: false })).text;
  const benCreate = (await ben('create_identity', { name: 'Ben', expose_local: false })).text;
  const annCid = cidOf(annCreate, 'Ann');
  const benCid = cidOf(benCreate, 'Ben');

  // Hub registers Ann and Ben via real invites under distinct names.
  const inv1 = blobOf((await hub('generate_invite', { name: 'Ann' })).text);
  await ann('add_contact', { invite: inv1, name: 'Hub' });
  await sleep(4000);
  const inv2 = blobOf((await hub('generate_invite', { name: 'Ben' })).text);
  await ben('add_contact', { invite: inv2, name: 'Hub' });
  await sleep(4000);
  const contacts0 = (await hub('list_contacts')).text;
  ok(/Ann/.test(contacts0) && /Ben/.test(contacts0), 'setup: Hub holds contacts "Ann" and "Ben" via real invite handshakes');

  // --- Phase 1: rename_contact -------------------------------------------
  // (spec test 8, non-collision half) renaming to a name another contact
  // holds is refused.
  const clash = await hub('rename_contact', { contact: 'Ben', name: 'Ann' });
  ok(clash.isError && /already held by contact/.test(clash.text) && new RegExp(annCid).test(clash.text),
    'P1: rename to a taken name is refused, naming the holder\'s container id');
  ok(!/Unknown contact/.test(clash.text), 'P1: the taken-name refusal does not carry the "Unknown contact" substring');

  // rename by CONTAINER ID succeeds and only rewrites the display name.
  const ren = await hub('rename_contact', { contact: benCid, name: 'Benny' });
  ok(!ren.isError && /Renamed contact "Ben" to "Benny"/.test(ren.text), 'P1: rename by container id succeeds');
  const contacts1 = (await hub('list_contacts')).text;
  ok(/Benny/.test(contacts1) && !/• Ben —/.test(contacts1), 'P1: list_contacts shows the new name only');

  // the established encrypted channel survives the rename: send by NEW name.
  const send = await hub('send_message', { contact: 'Benny', text: 'post-rename probe' });
  ok(!send.isError && /sent/i.test(send.text), 'P1: send_message to the renamed contact reports success');
  await sleep(3000);
  const benInbox = (await ben('get_messages')).text;
  ok(/post-rename probe/.test(benInbox), 'P1: the message DELIVERED over the surviving channel (recipient read it)');

  // unknown reference keeps the stable "Unknown contact" error.
  const unk = await hub('rename_contact', { contact: 'Nobody', name: 'X' });
  ok(unk.isError && /Unknown contact: Nobody/.test(unk.text), 'P1: renaming an unknown contact keeps the stable "Unknown contact" error');
} catch (err) {
  fail += 1;
  console.error('  ✗ SUITE ERROR:', err);
} finally {
  for (const { client, transport } of clients) { try { await transport.terminateSession(); await client.close(); } catch {} }
  daemon.kill('SIGTERM');
  broker.kill('SIGTERM');
  await sleep(500);
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\ncontact-uniqueness daemon suite: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
