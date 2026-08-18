// file-save-stream — issue #34: cross-OS-user file delivery without leaking bytes
// into the agent's model context, and without the recipient needing to read the
// daemon owner's private state dir.
//
// DESIGN under test:
//   get_files  — writes each received file to STATE_DIR/<id>/files/<wire>-<name>
//                and returns the PATH + metadata (name, mime, size, sha256,
//                sender, wire_id). NEVER the bytes. (~80%: the agent's OS user can
//                read that path and just copy it.)
//   save_file(wire_id, dest_path) — the cross-user path. The ours PROXY (running
//                as the AGENT's OS user) pulls the file's raw bytes from the
//                daemon's token-gated GET /files/<wire_id> stream and writes them
//                to dest_path. Bytes go daemon→proxy→disk, never into the tool
//                result / model context. The daemon-side save_file handler does
//                NOT write (it can't reach a cross-user dest) — it errors clearly,
//                which is exactly the old-proxy degrade path.
//   SCOPING    — GET /files/<wire_id> resolves the file STRICTLY within the BOUND
//                identity's own folder (identity taken from the lease token), so
//                identity A can never stream identity B's file.
//
// This test drives the REAL proxy (spawned via `ours-mcp proxy`, stdio) in front
// of the built daemon, and delivers a file Alice→Bob via intra-root sibling
// routing (in-process, no broker) — the same cross-user stand-in used for #34.
// Self-contained; run after build.

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync, symlinkSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { connectConnector } from './fixtures/connector-client.mjs';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'dist', 'cli.js');
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓', m)) : (fail++, console.log('  ✗ FAIL:', m)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

console.log('file-save-stream\n');

const port = await freePort();
const stateDir = mkdtempSync(join(tmpdir(), 'ours-savestream-'));
const daemon = spawn(process.execPath, [CLI, 'serve'], {
  env: {
    ...process.env,
    OURS_CONFIG: join(stateDir, 'test-config-does-not-exist.json'),
    OURS_TRANSPORT: 'http', OURS_PORT: String(port), OURS_STATE_DIR: stateDir,
    OURS_GC_INTERVAL_MS: '3600000', OURS_BROKER_URL: 'ws://127.0.0.1:59997/nobroker',
  },
  stdio: 'ignore', detached: true,
});

let token;
const proxies = [];
// A setup session. Was a direct MCP client on the daemon's /mcp; the daemon hosts
// no MCP server, so it is a connector with its own lease token — which is all the
// setup path ever needed it to be.
async function mkDirect(lease) {
  const conn = await connectConnector({ port, stateDir, leaseToken: lease });
  proxies.push(conn.client);
  return conn.client;
}
// Agent client fronted by the REAL ours proxy (spawned as the agent's OS user).
// `extraEnv` lets a case flip OURS_FILES_ALWAYS_PROMPT — the seam that exercises
// the "daemon copy is unreadable" branch from a single OS user (see below).
async function mkProxy(sessionId, extraEnv = {}) {
  const t = new StdioClientTransport({
    command: process.execPath, args: [CLI, 'proxy'],
    env: { ...process.env, OURS_PORT: String(port), OURS_STATE_DIR: stateDir, OURS_TRANSPORT: 'http', CLAUDE_CODE_SESSION_ID: sessionId, OURS_BROKER_URL: 'ws://127.0.0.1:59997/nobroker', ...extraEnv },
    stderr: 'ignore',
  });
  const c = new Client({ name: 'agent', version: '0' }); await c.connect(t); proxies.push(c); return c;
}
const partTypes = (content) => (content ?? []).map((p) => p.type);
const txt = (r) => (r.content ?? []).map((p) => p.type === 'text' ? p.text : `[${p.type}]`).join('\n');
const call = async (c, name, args = {}) => { const r = await c.callTool({ name, arguments: args }); return { isError: r.isError, text: txt(r), content: r.content ?? [], structured: r.structuredContent }; };

const SECRET = Buffer.from('BEGIN OPENSSH PRIVATE KEY \x00\x01\x02 ' + 'k'.repeat(500) + ' END', 'utf8');
const SECOND = Buffer.from('second approved-later file', 'utf8');

try {
  const deadline = Date.now() + 20_000; let up = false;
  while (Date.now() < deadline) { try { if ((await fetch(`http://127.0.0.1:${port}/version`)).ok) { up = true; break; } } catch {} await sleep(150); }
  ok(up, 'daemon starts');
  if (!up) throw new Error('daemon did not start');
  token = readFileSync(join(stateDir, 'daemon-token'), 'utf8').trim();

  // Host + Alice + Bob; Alice delivers a file to Bob (intra-root sibling, no broker).
  const setup = await mkDirect('setup');
  await call(setup, 'create_root_identity', { name: 'Host' });
  await call(setup, 'create_identity', { name: 'Alice' });
  await call(setup, 'create_identity', { name: 'Bob' });
  await call(setup, 'create_identity', { name: 'Carol' });
  const aliceIdentity = await call(setup, 'choose_identity', { name: 'Alice', force: true });
  const aliceCid = aliceIdentity.text.match(/\(([A-Fa-f0-9]{64})\)/)?.[1];
  ok(!!aliceCid, 'Alice authenticated CID is available');
  ok(!(await call(setup, 'send_message', { contact: 'Bob', text: 'file incoming' })).isError, 'Alice connects to Bob (sibling)');
  const sent = await call(setup, 'send_file', { contact: 'Bob', data_base64: SECRET.toString('base64'), filename: 'id_ed25519' });
  const wire = sent.text.match(/wire_id ([A-Fa-f0-9]+)/)?.[1];
  ok(!sent.isError && !!wire, 'Alice send_file to Bob');
  const sentSecond = await call(setup, 'send_file', {
    contact: 'Bob', data_base64: SECOND.toString('base64'), filename: '../../approved-later.txt', mime: 'text/plain',
  });
  const wireSecond = sentSecond.text.match(/wire_id ([A-Fa-f0-9]+)/)?.[1];
  ok(!sentSecond.isError && !!wireSecond, 'Alice sends a second independently selectable file to Bob');
  await call(setup, 'send_message', { contact: 'Carol', text: 'file incoming' });
  const sentC = await call(setup, 'send_file', { contact: 'Carol', data_base64: SECRET.toString('base64'), filename: 'id_ed25519' });
  const wireC = sentC.text.match(/wire_id ([A-Fa-f0-9]+)/)?.[1];
  ok(!sentC.isError && !!wireC, 'Alice send_file to Carol');
  const sentVoice = await call(setup, 'send_file', {
    contact: 'Carol', data_base64: Buffer.from('fake-voice').toString('base64'),
    filename: 'voice-message-20260803.ogg', mime: 'audio/ogg; x-ours-kind=voice-message',
  });
  const wireVoice = sentVoice.text.match(/wire_id ([A-Fa-f0-9]+)/)?.[1];
  ok(!sentVoice.isError && !!wireVoice, 'Alice sends a marked voice file to Carol');
  await sleep(400);
  const bobWakeEvents = readFileSync(join(stateDir, 'Bob', 'notifications.log'), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line)).filter((event) => event.event === 'file_received');
  ok(bobWakeEvents.length === 2 && bobWakeEvents.every((event) => event.sender_id === aliceCid)
    && bobWakeEvents.some((event) => event.wire_id === wire) && bobWakeEvents.some((event) => event.wire_id === wireSecond)
    && bobWakeEvents.every((event) => event.file_id && event.bytes && event.date),
  'body-free file wake metadata carries authenticated sender CID, stable IDs, byte count, and date');

  // ── get_files returns a PATH + metadata, never bytes ─────────────────────
  const bob = await mkProxy('sess-bob');
  ok((await bob.listTools()).tools.some((t) => t.name === 'save_file'), 'save_file tool is advertised');
  await call(bob, 'choose_identity', { name: 'Bob', force: true });
  const listed = await call(bob, 'list_incoming_files');
  const listedFiles = listed.structured?.files;
  ok(!listed.isError && listed.structured?.count === 2 && Array.isArray(listedFiles),
    'list_incoming_files returns stable structured metadata without retrieving bytes');
  const listedFirst = listedFiles?.find((f) => f.wire_id === wire);
  ok(listedFirst?.from?.id === aliceCid && listedFirst?.from?.name === 'Alice'
    && listedFirst?.file_id > 0 && listedFirst?.size === SECRET.length && listedFirst?.status === 'unread'
    && listedFirst?.sha256 === null && listedFirst?.date,
  'preauthorization metadata separates authenticated sender CID from untrusted display name and carries IDs/size/status/date');
  ok(!existsSync(join(stateDir, 'Bob', 'files')), 'metadata inspection writes zero received-file bytes');

  const malformed = await call(bob, 'get_files', { wire_ids: ['not-a-wire-id'] });
  ok(malformed.isError && malformed.structured?.error?.category === 'malformed_id', 'malformed selection fails closed');
  const duplicate = await call(bob, 'get_files', { wire_ids: [wire, wire] });
  ok(duplicate.isError && duplicate.structured?.error?.category === 'duplicate_id', 'duplicate selection fails closed');
  const overCap = await call(bob, 'get_files', { wire_ids: Array.from({ length: 33 }, (_, i) => i.toString(16).padStart(64, '0')) });
  ok(overCap.isError && overCap.structured?.error?.category === 'invalid_selection', 'selection cap fails closed');
  const unknown = await call(bob, 'get_files', { wire_ids: ['F'.repeat(64)] });
  ok(unknown.isError && unknown.structured?.error?.category === 'unknown_or_stale_id'
    && unknown.structured?.selection?.items?.[0]?.status === 'error',
  'unknown selection fails closed atomically with a structured per-item result');
  ok(!existsSync(join(stateDir, 'Bob', 'files')), 'invalid selections retrieve/write zero bytes');

  const bobFilesDir = join(stateDir, 'Bob', 'files');
  const onDisk = join(bobFilesDir, `${wire}-id_ed25519`);
  const symlinkVictim = join(stateDir, 'symlink-victim');
  mkdirSync(bobFilesDir, { recursive: true });
  writeFileSync(symlinkVictim, 'do-not-overwrite');
  symlinkSync(symlinkVictim, onDisk);
  const gf = await call(bob, 'get_files', { wire_ids: [wire] });
  ok(!gf.isError, 'Bob get_files succeeds');
  ok(!partTypes(gf.content).includes('resource'), 'get_files returns NO embedded-resource/bytes part');
  ok(existsSync(onDisk) && readFileSync(onDisk).equals(SECRET), 'get_files wrote the file to the per-identity folder (byte-exact)');
  ok(readFileSync(symlinkVictim, 'utf8') === 'do-not-overwrite' && !lstatSync(onDisk).isSymbolicLink(),
    'safe atomic write replaces the destination entry without following a symlink');
  ok(gf.text.includes(onDisk), 'get_files result carries the on-disk PATH');
  ok(/sha256 [a-f0-9]{64}/.test(gf.text) && new RegExp(`${SECRET.length} B`).test(gf.text), 'get_files result carries sha256 + size metadata');
  // The proxy probed the path as THIS OS user, found it readable, and passed the
  // daemon's result through untouched — annotating the structured record only.
  const gfFiles = gf.structured?.files;
  ok(Array.isArray(gfFiles) && gfFiles.length === 1 && gfFiles[0].path === onDisk && gfFiles[0].wire_id === wire,
    'get_files carries structuredContent records (wire_id + path) for the proxy to probe');
  ok(gfFiles?.[0]?.readable === true, 'proxy marked the readable path readable and did NOT rewrite the result');
  ok(gfFiles?.[0]?.from?.id === aliceCid && gfFiles?.[0]?.status === 'processed' && gfFiles?.[0]?.file_id === listedFirst.file_id,
    'selected retrieval result preserves authenticated provenance, stable ids, and processed status');
  ok(!/NOT readable by your OS user/.test(gf.text), 'readable case is a transparent passthrough (no destination prompt)');
  const secondOnDisk = join(stateDir, 'Bob', 'files', `${wireSecond}-approved-later.txt`);
  ok(!existsSync(secondOnDisk), 'selective retrieval does not write the unselected unread file');
  const afterSelected = await call(bob, 'list_incoming_files');
  ok(afterSelected.structured?.files?.find((f) => f.wire_id === wire)?.status === 'processed'
    && afterSelected.structured?.files?.find((f) => f.wire_id === wireSecond)?.status === 'unread',
  'selective retrieval leaves the other file unread');

  const stale = await call(bob, 'get_files', { wire_ids: [wire] });
  ok(stale.isError && stale.structured?.error?.category === 'unknown_or_stale_id', 'already-processed selection is rejected as stale');
  const bulk = await call(bob, 'get_files');
  ok(!bulk.isError && bulk.structured?.selection?.mode === 'all_unread'
    && bulk.structured?.files?.length === 1 && bulk.structured.files[0].wire_id === wireSecond,
  'no-argument get_files preserves legacy bulk retrieval behavior');
  ok(existsSync(secondOnDisk) && readFileSync(secondOnDisk).equals(SECOND),
    'legacy bulk retrieval writes the remaining unread file with a traversal-safe basename');

  // ── save_file streams the bytes to an agent-chosen dest via the proxy ─────
  const dest = join(stateDir, 'agent-home', 'saved_key');
  const sf = await call(bob, 'save_file', { wire_id: wire, dest_path: dest });
  ok(!sf.isError, 'save_file via proxy succeeds');
  ok(!partTypes(sf.content).includes('resource'), 'save_file result carries NO bytes (no embedded resource)');
  ok(!/[A-Za-z0-9+/]{200,}={0,2}/.test(sf.text), 'save_file result carries no base64 blob of the file');
  ok(existsSync(dest) && readFileSync(dest).equals(SECRET), 'save_file wrote the file byte-exact at the agent-chosen dest');

  // ── UNREADABLE daemon copy: proxy asks the agent for a destination ────────
  // The proxy probes each get_files path with access(R_OK) as the AGENT's OS user.
  // A genuine cross-user split can't be staged from one uid (the daemon must be
  // able to WRITE where the agent cannot READ), so we drive the same branch via
  // OURS_FILES_ALWAYS_PROMPT — the supported "always place files explicitly" mode,
  // which forces the probe to report unreadable.
  const carol = await mkProxy('sess-carol', { OURS_FILES_ALWAYS_PROMPT: '1' });
  await call(carol, 'choose_identity', { name: 'Carol', force: true });
  const gfC = await call(carol, 'get_files');
  const carolOnDisk = join(stateDir, 'Carol', 'files', `${wireC}-id_ed25519`);
  ok(!gfC.isError, 'Carol get_files succeeds');
  ok(/NOT readable by your OS user/.test(gfC.text), 'unreadable daemon copy is reported to the agent');
  ok(/ASK WHERE TO SAVE/.test(gfC.text) && /save_file\(\{ wire_id, dest_path \}\)/.test(gfC.text),
    'proxy instructs the agent to ask the user for a destination and call save_file');
  ok(gfC.text.includes(`wire_id ${wireC}`) && gfC.text.includes('id_ed25519') && /sha256 [a-f0-9]{64}/.test(gfC.text)
    && new RegExp(`${SECRET.length} B`).test(gfC.text) && gfC.text.includes('from Alice'),
    'the prompt carries the metadata the agent needs to describe the file (name, size, sha256, sender, wire_id)');
  ok(/IGNORE the on-disk paths/.test(gfC.text), 'the prompt tells the agent to ignore the unusable paths');
  // The instruction is PREPENDED, never substituted: the daemon's own text can carry
  // payload the proxy cannot reconstruct (a voice message is delivered as a TRANSCRIPT,
  // not as a path), so replacing it would drop real content from a mixed batch.
  ok(gfC.content.length === 2 && gfC.content[0].type === 'text' && /NOT readable by your OS user/.test(gfC.content[0].text),
    'the instruction is a NEW leading text part, not a replacement');
  ok(gfC.content[1]?.text?.includes(carolOnDisk),
    "the daemon's original listing is preserved intact after the instruction");
  ok(!partTypes(gfC.content).includes('resource') && !/[A-Za-z0-9+/]{200,}={0,2}/.test(gfC.text),
    'the prompt carries no bytes / no base64 blob');
  ok(gfC.structured?.files?.[0]?.readable === false, 'structured record is marked unreadable');
  const voiceRecord = gfC.structured?.files?.find((f) => f.wire_id === wireVoice);
  ok(voiceRecord?.kind === 'voice_message' && voiceRecord?.transcription?.status === 'unavailable'
    && voiceRecord.transcription.configured === false && voiceRecord.transcription.attempted === false
    && voiceRecord.transcription.error_category === 'not_configured'
    && voiceRecord.transcription.audio_path === voiceRecord.path
    && voiceRecord.transcription.file_wire_id === wireVoice,
  'voice fallback is structured with explicit configuration/attempt/status and audio association');
  ok(/cannot transcribe/.test(gfC.text) && gfC.text.includes(`{${wireVoice}}`),
    'voice fallback preserves the existing human-readable delivery line');
  // …the agent answers with a path, and save_file completes the delivery.
  const carolDest = join(stateDir, 'agent-home', 'carol-chosen', 'key.pem');
  const sfC = await call(carol, 'save_file', { wire_id: wireC, dest_path: carolDest });
  ok(!sfC.isError, 'save_file at the agent-chosen destination succeeds');
  ok(existsSync(carolDest) && readFileSync(carolDest).equals(SECRET),
    'the file lands byte-exact at the path the agent chose (dirs created as needed)');

  // ── DELETED: "the daemon does not write dest directly" ────────────────────
  // It asserted that calling save_file straight at the daemon errors instead of
  // writing, proving only the proxy performed the cross-user write. There is no
  // daemon-side save_file path any more: the daemon hosts no tools at all, and the
  // connector — which runs as the agent's OS user — does the write itself. The case
  // exercised a component that no longer exists.
  //
  // What it was really protecting still is: the daemon never writes a caller-chosen
  // path. That is now true by construction rather than by assertion, because the
  // daemon has no handler that could.

  // ── SCOPING: identity A cannot save identity B's file ─────────────────────
  const alice = await mkProxy('sess-alice');
  await call(alice, 'choose_identity', { name: 'Alice', force: true });
  const stolen = join(stateDir, 'agent-home', 'stolen_key');
  const steal = await call(alice, 'save_file', { wire_id: wire, dest_path: stolen });
  ok(steal.isError, 'save_file with another identity\'s wire_id is REJECTED');
  ok(!existsSync(stolen), 'the other identity\'s file was NOT written (no cross-identity exfil)');

  // Belt-and-suspenders: the raw stream endpoint is scoped by lease token too —
  // Bob's session token streams the file; Alice's session token gets 404.
  const bobStream = await fetch(`http://127.0.0.1:${port}/files/${wire}`, { headers: { 'x-ours-api-token': token, 'x-ours-lease-token': 'sess-bob' } });
  ok(bobStream.status === 200 && Buffer.from(await bobStream.arrayBuffer()).equals(SECRET), 'GET /files streams byte-exact for the bound owner (Bob)');
  const aliceStream = await fetch(`http://127.0.0.1:${port}/files/${wire}`, { headers: { 'x-ours-api-token': token, 'x-ours-lease-token': 'sess-alice' } });
  ok(aliceStream.status === 404, 'GET /files is 404 for a different identity (Alice) — scoping enforced daemon-side');
} catch (e) {
  fail++;
  console.log('  ✗ FAIL: unexpected error:', e && e.stack ? e.stack : String(e));
} finally {
  for (const c of proxies) { try { await c.close(); } catch {} }
  try { process.kill(-daemon.pid, 'SIGKILL'); } catch {}
  rmSync(stateDir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
