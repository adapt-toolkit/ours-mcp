// file-delivery-api — issue #34: cross-OS-user file delivery must NOT depend on
// the recipient reading the daemon owner's private state dir.
//
// THE BUG (0.11.2): one shared daemon per host owns every identity's packet, so
// its state dir sits under the owner's 0700 HOME. `get_files` wrote received
// bytes to STATE_DIR/<identity>/files/… and handed the recipient that PATH. A
// recipient running as a DIFFERENT OS user (isolation by design) cannot traverse
// the owner's HOME → EACCES: delivered at the protocol layer, unreadable at the
// filesystem layer. Loosening HOME perms / moving to a group-shared path would
// leak every identity's files to every same-group agent, so that's off the table.
//
// THE FIX (approach a): `get_files` streams the bytes back over the SAME
// token-gated /mcp channel the recipient already authenticates on — as an MCP
// embedded resource (base64 blob) — and writes nothing to the owner's state dir.
//
// This test proves both halves of the property WITHOUT needing two real OS users:
//   (1) the recipient gets the correct BYTES from the API result, and
//   (2) NO file bytes are written under the daemon-private state dir — so a
//       cross-user recipient (which cannot read that dir) is unaffected.
// Both assertions FAIL on the pre-fix code (which returned a path and wrote to
// STATE_DIR/<id>/files) and PASS after — the required RED→GREEN.
// Confidentiality: a third same-host identity's get_files must NOT see the file.
//
// Delivery is intra-root sibling (delegation-cert), which routes in-process
// between identities on the one daemon — no broker needed (BROKER_URL is bogus).
// Self-contained: spawns the BUILT daemon and drives it over MCP. Run after build.

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'dist', 'cli.js');
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓', m)) : (fail++, console.log('  ✗ FAIL:', m)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

// Recursively list every regular file under a dir (the daemon-private state dir).
function walk(dir) {
  const out = [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

console.log('file-delivery-api\n');

// Note on confidentiality vs. this test's filesystem assertions: the recipient's
// own encrypted packet (STATE_DIR/<id>/state_data.bin) legitimately holds the
// received bytes at rest — that is the daemon's pre-existing private per-identity
// storage, the SAME place inbound messages live, and is not what #34 is about.
// The bug is the SEPARATE plaintext handoff: get_files used to write
// STATE_DIR/<id>/files/<wire>-<name> and hand the recipient that path. So the
// filesystem assertions below target that handoff dir specifically.

const port = await freePort();
const stateDir = mkdtempSync(join(tmpdir(), 'ours-filedeliv-'));
const daemon = spawn(process.execPath, [CLI, 'serve'], {
  env: {
    ...process.env,
    OURS_TRANSPORT: 'http',
    OURS_PORT: String(port),
    OURS_STATE_DIR: stateDir,
    OURS_GC_INTERVAL_MS: '3600000',
    OURS_BROKER_URL: 'ws://127.0.0.1:59997/nobroker',
  },
  stdio: 'ignore',
  detached: true,
});

const url = new URL(`http://127.0.0.1:${port}/mcp`);
// Bindings key on x-ours-lease-token (not the mcp-session-id), so each identity
// gets its own stable lease token — one MCP client per identity.
async function mkClient(token, lease) {
  const t = new StreamableHTTPClientTransport(url, { requestInit: { headers: { 'x-ours-api-token': token, 'x-ours-lease-token': lease } } });
  const c = new Client({ name: 'file-delivery-test', version: '0.0.0' });
  await c.connect(t);
  return c;
}
const txt = (r) => (r.content ?? []).map((p) => (p.type === 'text' ? p.text : `[${p.type}]`)).join('\n');
const call = async (c, name, args = {}) => { const r = await c.callTool({ name, arguments: args }); return { isError: r.isError, text: txt(r), content: r.content ?? [] }; };

// The exact bytes Alice sends — includes NUL + control bytes so a text-only /
// path-only egress can't accidentally look correct.
const SECRET = Buffer.from('ours-issue-34 \x00\x01\x02 secret payload ✓', 'utf8');

let a, b, cc;
try {
  const deadline = Date.now() + 20_000;
  let up = false;
  while (Date.now() < deadline) { try { if ((await fetch(`http://127.0.0.1:${port}/version`)).ok) { up = true; break; } } catch {} await sleep(150); }
  ok(up, 'daemon starts');
  if (!up) throw new Error('daemon did not start');
  const token = readFileSync(join(stateDir, 'daemon-token'), 'utf8').trim();

  // Host root + three sibling roles (all on the ONE shared daemon).
  a = await mkClient(token, 'lease-alice');
  await call(a, 'create_root_identity', { name: 'Host' });
  ok(!(await call(a, 'create_identity', { name: 'Alice' })).isError, 'create Alice');
  b = await mkClient(token, 'lease-bob');
  ok(!(await call(b, 'create_identity', { name: 'Bob' })).isError, 'create Bob');
  cc = await mkClient(token, 'lease-carol');
  ok(!(await call(cc, 'create_identity', { name: 'Carol' })).isError, 'create Carol');

  // Alice → Bob: connect (intra-root sibling) then send the file.
  await call(a, 'choose_identity', { name: 'Alice', force: true });
  const conn = await call(a, 'send_message', { contact: 'Bob', text: 'incoming file' });
  ok(!conn.isError, 'Alice connects + messages Bob (intra-root sibling, no broker)');
  const sent = await call(a, 'send_file', { contact: 'Bob', data_base64: SECRET.toString('base64'), filename: 'secret.bin' });
  ok(!sent.isError && /sent to "Bob"/.test(sent.text), 'Alice send_file to Bob');

  await sleep(500);

  // ── Recipient retrieves via the API ──────────────────────────────────────
  await call(b, 'choose_identity', { name: 'Bob', force: true });
  const got = await call(b, 'get_files');
  ok(!got.isError, 'Bob get_files succeeds');

  // (1) BYTES come back over the channel as an embedded resource, byte-exact.
  const resParts = got.content.filter((p) => p.type === 'resource' && p.resource && typeof p.resource.blob === 'string');
  ok(resParts.length === 1, 'get_files returns exactly one embedded-resource part (bytes over the channel)');
  const delivered = resParts.length ? Buffer.from(resParts[0].resource.blob, 'base64') : Buffer.alloc(0);
  ok(delivered.equals(SECRET), 'delivered bytes exactly match what Alice sent');
  ok(resParts.length > 0 && resParts[0].resource.mimeType === 'application/octet-stream', 'embedded resource carries the mime type');

  // (2) get_files created NO plaintext handoff file the recipient must read from
  // the daemon owner's private dir — the exact EACCES trigger. Pre-fix it wrote
  // STATE_DIR/Bob/files/<wire>-secret.bin (a NEW plaintext file carrying the
  // bytes) and this fails; post-fix nothing new lands there.
  const filesDir = join(stateDir, 'Bob', 'files');
  ok(!existsSync(filesDir), 'get_files does not create the daemon-private files/ handoff dir');
  const newPlaintext = walk(filesDir).filter((p) => { try { return readFileSync(p).includes(SECRET); } catch { return false; } });
  ok(newPlaintext.length === 0, 'no plaintext copy of the bytes is written for the recipient to fetch from disk (cross-user safe)');
  if (newPlaintext.length) console.log('    leaked at:', newPlaintext.join(', '));

  // The summary must not point the recipient at a path inside the private dir.
  ok(!got.text.includes(stateDir), 'get_files summary contains no daemon-private filesystem path');

  // ── Confidentiality: a same-host sibling must NOT get Bob's file ──────────
  await call(cc, 'choose_identity', { name: 'Carol', force: true });
  const carol = await call(cc, 'get_files');
  const carolRes = carol.content.filter((p) => p.type === 'resource');
  ok(carolRes.length === 0 && /No new files/.test(carol.text), 'a different same-host identity (Carol) cannot read Bob\'s file');
} catch (e) {
  fail++;
  console.log('  ✗ FAIL: unexpected error:', e && e.stack ? e.stack : String(e));
} finally {
  try { await a?.close(); } catch {}
  try { await b?.close(); } catch {}
  try { await cc?.close(); } catch {}
  try { process.kill(-daemon.pid, 'SIGKILL'); } catch {}
  rmSync(stateDir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
