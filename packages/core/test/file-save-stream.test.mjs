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
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
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
  env: { ...process.env, OURS_TRANSPORT: 'http', OURS_PORT: String(port), OURS_STATE_DIR: stateDir, OURS_GC_INTERVAL_MS: '3600000', OURS_BROKER_URL: 'ws://127.0.0.1:59997/nobroker' },
  stdio: 'ignore', detached: true,
});

const url = new URL(`http://127.0.0.1:${port}/mcp`);
let token;
const proxies = [];
// Direct daemon MCP client (used for setup + the daemon-side save_file check).
async function mkDirect(lease) {
  const t = new StreamableHTTPClientTransport(url, { requestInit: { headers: { 'x-ours-api-token': token, 'x-ours-lease-token': lease } } });
  const c = new Client({ name: 'direct', version: '0' }); await c.connect(t); return c;
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
  await call(setup, 'choose_identity', { name: 'Alice', force: true });
  ok(!(await call(setup, 'send_message', { contact: 'Bob', text: 'file incoming' })).isError, 'Alice connects to Bob (sibling)');
  const sent = await call(setup, 'send_file', { contact: 'Bob', data_base64: SECRET.toString('base64'), filename: 'id_ed25519' });
  const wire = sent.text.match(/wire_id ([A-Fa-f0-9]+)/)?.[1];
  ok(!sent.isError && !!wire, 'Alice send_file to Bob');
  await call(setup, 'send_message', { contact: 'Carol', text: 'file incoming' });
  const sentC = await call(setup, 'send_file', { contact: 'Carol', data_base64: SECRET.toString('base64'), filename: 'id_ed25519' });
  const wireC = sentC.text.match(/wire_id ([A-Fa-f0-9]+)/)?.[1];
  ok(!sentC.isError && !!wireC, 'Alice send_file to Carol');
  await sleep(400);

  // ── get_files returns a PATH + metadata, never bytes ─────────────────────
  const bob = await mkProxy('sess-bob');
  ok((await bob.listTools()).tools.some((t) => t.name === 'save_file'), 'save_file tool is advertised');
  await call(bob, 'choose_identity', { name: 'Bob', force: true });
  const gf = await call(bob, 'get_files');
  ok(!gf.isError, 'Bob get_files succeeds');
  ok(!partTypes(gf.content).includes('resource'), 'get_files returns NO embedded-resource/bytes part');
  const onDisk = join(stateDir, 'Bob', 'files', `${wire}-id_ed25519`);
  ok(existsSync(onDisk) && readFileSync(onDisk).equals(SECRET), 'get_files wrote the file to the per-identity folder (byte-exact)');
  ok(gf.text.includes(onDisk), 'get_files result carries the on-disk PATH');
  ok(/sha256 [a-f0-9]{64}/.test(gf.text) && new RegExp(`${SECRET.length} B`).test(gf.text), 'get_files result carries sha256 + size metadata');
  // The proxy probed the path as THIS OS user, found it readable, and passed the
  // daemon's result through untouched — annotating the structured record only.
  const gfFiles = gf.structured?.files;
  ok(Array.isArray(gfFiles) && gfFiles.length === 1 && gfFiles[0].path === onDisk && gfFiles[0].wire_id === wire,
    'get_files carries structuredContent records (wire_id + path) for the proxy to probe');
  ok(gfFiles?.[0]?.readable === true, 'proxy marked the readable path readable and did NOT rewrite the result');
  ok(!/NOT readable by your OS user/.test(gf.text), 'readable case is a transparent passthrough (no destination prompt)');

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
  // …the agent answers with a path, and save_file completes the delivery.
  const carolDest = join(stateDir, 'agent-home', 'carol-chosen', 'key.pem');
  const sfC = await call(carol, 'save_file', { wire_id: wireC, dest_path: carolDest });
  ok(!sfC.isError, 'save_file at the agent-chosen destination succeeds');
  ok(existsSync(carolDest) && readFileSync(carolDest).equals(SECRET),
    'the file lands byte-exact at the path the agent chose (dirs created as needed)');

  // ── the DAEMON does not write dest directly (old-proxy / direct-call path) ─
  // Calling save_file straight at the daemon (no proxy) must NOT create dest — it
  // errors clearly and defers to the proxy. This proves the daemon never performs
  // the cross-user write; only the proxy does.
  const bobDirect = await mkDirect('bob-direct');
  await call(bobDirect, 'choose_identity', { name: 'Bob', force: true });
  const destDaemon = join(stateDir, 'agent-home', 'daemon_should_not_write');
  const sfDaemon = await call(bobDirect, 'save_file', { wire_id: wire, dest_path: destDaemon });
  ok(sfDaemon.isError, 'daemon-side save_file (no proxy) errors clearly instead of writing');
  ok(!existsSync(destDaemon), 'daemon-side save_file did NOT write the destination file');
  // re-bind Bob to the proxy session for any later use
  await call(bob, 'choose_identity', { name: 'Bob', force: true });

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
