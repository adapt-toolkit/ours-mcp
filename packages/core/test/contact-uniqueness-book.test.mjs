// packages/core/test/contact-uniqueness-book.test.mjs
//
// SPEC test 9 — retiring an identity must not collaterally delete a same-named
// replacement's local-contact-book entry (SPEC P3a).
//
// The book is keyed by NAME; publishToBook overwrites the name key. When the
// name key has come to be owned by a DIFFERENT container id than the identity
// being retired (a replacement claimed the name — the state the incident's
// role-respawn produces once books diverge), the old unpublish-by-name deleted
// the REPLACEMENT's entry. The fix matches on container id: the retiree
// removes only an entry that is actually its own.
//
// The divergent book is arranged by editing book.json between daemon runs —
// entries are host-local bookkeeping (the registrar signature is verified at
// CONNECT time, not by unpublish), so this models the divergence directly.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'dist', 'cli.js');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓', m)) : (fail++, console.log('  ✗ FAIL:', m)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
const txt = (r) => (Array.isArray(r.content) ? r.content : []).map((c) => (typeof c.text === 'string' ? c.text : '')).join('\n');

const dir = mkdtempSync(join(tmpdir(), 'a2a-book-'));
const bookPath = join(dir, 'contact-book', 'book.json');

async function withDaemon(fn) {
  const PORT = await freePort();
  const daemon = spawn('node', [CLI, 'serve'], {
    env: { ...process.env, OURS_TRANSPORT: 'http', OURS_PORT: String(PORT), OURS_STATE_DIR: dir, OURS_BROKER_URL: 'wss://invalid.local/none', OURS_API_VISIBILITY: 'open' },
    stdio: 'ignore',
  });
  try {
    for (let i = 0; i < 120; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/version`)).ok) break; } catch {} await sleep(250); }
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
      requestInit: { headers: { 'x-ours-lease-token': `book-test-${PORT}`, 'x-ours-client-pid': String(process.pid) } },
    });
    const client = new Client({ name: 'book-test', version: '0.0.0' });
    await client.connect(transport);
    const call = async (name, args = {}) => {
      const r = await client.callTool({ name, arguments: args });
      return { text: txt(r), isError: !!r.isError };
    };
    await fn(call);
    try { await transport.terminateSession(); await client.close(); } catch {}
  } finally {
    daemon.kill('SIGTERM');
    await sleep(1000);
  }
}

try {
  let patCid = '', robCid = '';
  await withDaemon(async (call) => {
    await call('create_identity', { name: 'Hub', expose_local: false });
    patCid = txt0((await call('create_identity', { name: 'Pat', expose_local: true })).text);
    robCid = txt0((await call('create_identity', { name: 'Rob', expose_local: true })).text);
  });
  function txt0(t) { return t.match(/\(([0-9A-F]{64})\)/)?.[1] ?? ''; }

  const readEntries = () => JSON.parse(readFileSync(bookPath, 'utf8'));
  const book0 = readEntries();
  ok(book0.entries.Pat?.container_id === patCid && book0.entries.Rob?.container_id === robCid,
    'setup: Pat and Rob are published in the book under their own names');

  // Divergence: the "Pat" name key is now owned by a DIFFERENT container id (a
  // replacement claimed the name). The retiree (patCid) has no entry of its own.
  book0.entries.Pat.container_id = robCid;
  writeFileSync(bookPath, JSON.stringify(book0, null, 2));

  await withDaemon(async (call) => {
    const rm = await call('remove_identity', { name: 'Pat' });
    ok(!rm.isError, 'retire: remove_identity "Pat" succeeds');
  });

  const book1 = readEntries();
  ok(book1.entries.Pat?.container_id === robCid,
    'SPEC9: retiring "Pat" did NOT collaterally delete the same-named replacement\'s entry (cid-matched unpublish)');

  // And the converse: unpublish removes the entry that IS the retiree's cid.
  // Point the "Pat" key at an unrelated cid first so exactly one entry carries
  // Rob's container id.
  book1.entries.Pat.container_id = 'F'.repeat(64);
  writeFileSync(bookPath, JSON.stringify(book1, null, 2));
  await withDaemon(async (call) => {
    const rm = await call('remove_identity', { name: 'Rob' });
    ok(!rm.isError, 'retire: remove_identity "Rob" succeeds');
  });
  const book2 = readEntries();
  ok(book2.entries.Rob === undefined, 'SPEC9: the retiree\'s own entry IS removed when the cid matches');
  ok(book2.entries.Pat !== undefined, 'SPEC9: unrelated entries are untouched');
} catch (err) {
  fail += 1;
  console.error('  ✗ SUITE ERROR:', err);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\ncontact-uniqueness book unpublish: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
