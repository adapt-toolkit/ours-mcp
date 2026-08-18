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
import { connectConnector } from './fixtures/connector-client.mjs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
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
  // One connector per identity, each with its own lease token — so each is its own
  // session and nothing rebinds.
  const conn = await connectConnector({ port: PORT, stateDir: dir, leaseToken: `uniq-${tag}-${PORT}` });
  const client = conn.client;
  clients.push(conn);
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

  // --- Phase 3: register_contact — D1 regression, ordinals, the incident ---
  const notifyLog = (name) => {
    try { return readFileSync(join(dir, name, 'notifications.log'), 'utf8'); } catch { return ''; }
  };

  // SPEC test 3 (D1 regression — the test a future contributor is most likely
  // to break by tightening the check): an invite whose assigned name is already
  // taken SUCCEEDS, registers the newcomer as "<name> 1", warns, and the
  // handshake completes. No transaction aborts anywhere.
  const cat = await mkClient('cat');
  const catCreate = (await cat('create_identity', { name: 'Cat', expose_local: false })).text;
  const catCid = cidOf(catCreate, 'Cat');
  const inv3 = blobOf((await hub('generate_invite', { name: 'Ann' })).text);
  const catAdd = await cat('add_contact', { invite: inv3, name: 'Hub' });
  ok(!catAdd.isError, 'SPEC3: add_contact against a taken assigned name does NOT refuse');
  await sleep(4000);
  const contacts3 = (await hub('list_contacts')).text;
  ok(new RegExp(`Ann 1 — ${catCid}`).test(contacts3), 'SPEC3: the newcomer registered as "Ann 1" (lowest free ordinal)');
  ok(new RegExp(`Ann — ${annCid}`).test(contacts3), 'SPEC3: the clean name stayed with the first arrival (D3)');
  const hubLog3 = notifyLog('Hub');
  ok(/contact_name_collision/.test(hubLog3) && hubLog3.includes(annCid) && hubLog3.includes(catCid),
    'SPEC3: the collision warning fired, naming BOTH container ids');

  // SPEC test 6 — ordinals: a third "Ann" becomes "Ann 2"; an existing literal
  // "Q 1" contact is skipped, not clobbered.
  const dog = await mkClient('dog');
  const dogCid = cidOf((await dog('create_identity', { name: 'Dog', expose_local: false })).text, 'Dog');
  const inv4 = blobOf((await hub('generate_invite', { name: 'Ann' })).text);
  await dog('add_contact', { invite: inv4, name: 'Hub' });
  await sleep(4000);
  ok(new RegExp(`Ann 2 — ${dogCid}`).test((await hub('list_contacts')).text),
    'SPEC6: with "Ann" and "Ann 1" present, the third collision becomes "Ann 2"');
  // occupy "Q 1" literally, then collide on "Q" twice: the literal is skipped.
  await hub('rename_contact', { contact: benCid, name: 'Q 1' });
  await hub('rename_contact', { contact: annCid, name: 'Q' });
  const emu = await mkClient('emu');
  const emuCid = cidOf((await emu('create_identity', { name: 'Emu', expose_local: false })).text, 'Emu');
  const inv5 = blobOf((await hub('generate_invite', { name: 'Q' })).text);
  await emu('add_contact', { invite: inv5, name: 'Hub' });
  await sleep(4000);
  const contacts6 = (await hub('list_contacts')).text;
  ok(new RegExp(`Q 2 — ${emuCid}`).test(contacts6), 'SPEC6: colliding with "Q" while a literal "Q 1" exists yields "Q 2"');
  ok(new RegExp(`Q 1 — ${benCid}`).test(contacts6), 'SPEC6: the literal "Q 1" contact was skipped, not clobbered');

  // SPEC test 4 — THE INCIDENT: a respawned role with a new container id and
  // the same label writes a second entry via the sibling path, created by a
  // remote party with no local action. The newcomer takes the suffix, the
  // original keeps the bare name, the first message still lands, and the
  // warning names both ids.
  const rex1 = await mkClient('rex1');
  const rex1Cid = cidOf((await rex1('create_identity', { name: 'Rex', expose_local: false })).text, 'Rex');
  const s1 = await rex1('send_message', { contact: 'Ann', text: 'first Rex reporting' });
  ok(!s1.isError, 'SPEC4 setup: first Rex reaches Ann via the sibling path');
  await sleep(3000);
  ok(/first Rex reporting/.test((await ann('get_messages')).text), 'SPEC4 setup: Ann received the first Rex message');
  await hub('remove_identity', { name: 'Rex' });
  const rex2 = await mkClient('rex2');
  const rex2Cid = cidOf((await rex2('create_identity', { name: 'Rex', expose_local: false })).text, 'Rex');
  ok(rex2Cid !== null && rex2Cid !== rex1Cid, 'SPEC4 setup: the respawned Rex has a NEW container id');
  const s2 = await rex2('send_message', { contact: 'Ann', text: 'respawned Rex reporting' });
  ok(!s2.isError, 'SPEC4: the respawned Rex message is not refused (D1)');
  await sleep(3000);
  ok(/respawned Rex reporting/.test((await ann('get_messages')).text), 'SPEC4: the respawned Rex message ARRIVED');
  const annBook = (await ann('list_contacts')).text;
  ok(new RegExp(`Rex — ${rex1Cid}`).test(annBook), 'SPEC4: the dead predecessor still holds the bare name "Rex" (D3)');
  ok(new RegExp(`Rex 1 — ${rex2Cid}`).test(annBook), 'SPEC4: the live replacement registered as "Rex 1"');
  const annLog = notifyLog('Ann');
  ok(/contact_name_collision/.test(annLog) && annLog.includes(rex1Cid) && annLog.includes(rex2Cid),
    'SPEC4: the collision warning on Ann names both container ids');

  // SPEC test 5 — the D3 CONSEQUENCE (intended, not desired): a send to the
  // bare name "Rex" deterministically resolves to the DEAD predecessor — the
  // collision warning and rename_contact are the only mitigations until D4.
  const s3 = await ann('send_message', { contact: 'Rex', text: 'who gets this?' });
  ok(!s3.isError && !new RegExp(rex2Cid).test(s3.text),
    'SPEC5: send to the bare name resolves to the dead predecessor, not the live replacement (D3 consequence)');
  await sleep(2000);
  ok(!/who gets this\?/.test((await rex2('get_messages')).text),
    'SPEC5: the live replacement did NOT receive the bare-name send');
} catch (err) {
  fail += 1;
  console.error('  ✗ SUITE ERROR:', err);
} finally {
  for (const c of clients) { try { await c.close(); } catch { /* already gone */ } }
  daemon.kill('SIGTERM');
  broker.kill('SIGTERM');
  await sleep(500);
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\ncontact-uniqueness daemon suite: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
