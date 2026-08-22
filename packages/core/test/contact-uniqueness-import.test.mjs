// packages/core/test/contact-uniqueness-import.test.mjs
//
// SPEC test 7 — the dedup-on-import sweep, against the REAL pre-fix state.
//
// The fixture (test/fixtures/dup-contacts-*) is BookKeeper's on-disk identity
// captured from the PRE-UNIQUENESS build (ours-mcp 849a355 / core edbb11ad):
// two contacts BOTH named "Twin", produced by real invite handshakes — see
// test/fixtures/gen-dup-contacts-fixture.mjs, which can only reproduce it
// against that old build (the fixed build suffixes at registration). This is
// the only honest evidence of the broken state: it cannot be regenerated.
//
// Asserts: on boot (restoreIdentity -> import_core_state) the sweep gives the
// LOWEST container id (byte order) the bare name and the other "Twin 1";
// nothing is deleted; peer_ads survive (neither contact reads as degraded);
// the renamed entry carries the renamed-on-import marker; a second boot is
// STABLE (same names, no "Twin 2", marker persists); rename_contact settles
// the mark.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync, mkdirSync, copyFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'dist', 'cli.js');
const FIX = join(HERE, 'fixtures');
const meta = JSON.parse(readFileSync(join(FIX, 'dup-contacts-meta.json'), 'utf8'));
// The sweep's tie-break: lowest container id by byte order keeps the bare name.
const [keeper, renamed] = [...meta.twin_cids].sort();

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓', m)) : (fail++, console.log('  ✗ FAIL:', m)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
const txt = (r) => (Array.isArray(r.content) ? r.content : []).map((c) => (typeof c.text === 'string' ? c.text : '')).join('\n');

const dir = mkdtempSync(join(tmpdir(), 'a2a-import-'));
const idDir = join(dir, 'BookKeeper');
mkdirSync(idDir, { recursive: true });
copyFileSync(join(FIX, 'dup-contacts-state.bin'), join(idDir, 'state_data.bin'));
copyFileSync(join(FIX, 'dup-contacts-identity.key'), join(idDir, 'identity.key'));

async function withDaemon(fn) {
  const PORT = await freePort();
  // Never a real broker — this test only cares about local restore-on-boot behavior.
  const daemon = spawn('node', [CLI, 'serve'], {
    env: { ...process.env, OURS_TRANSPORT: 'http', OURS_PORT: String(PORT), OURS_STATE_DIR: dir, OURS_BROKER_URL: 'wss://invalid.local/none', OURS_API_VISIBILITY: 'open' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  daemon.stderr.setEncoding('utf8');
  daemon.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    for (let i = 0; i < 120; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/version`)).ok) break; } catch {} await sleep(250); }
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
      requestInit: { headers: { 'x-ours-lease-token': `import-test-${PORT}`, 'x-ours-client-pid': String(process.pid) } },
    });
    const client = new Client({ name: 'import-test', version: '0.0.0' });
    await client.connect(transport);
    const call = async (name, args = {}) => {
      const r = await client.callTool({ name, arguments: args });
      return { text: txt(r), isError: !!r.isError };
    };
    await fn(call, () => stderr, PORT);
    try { await transport.terminateSession(); await client.close(); } catch {}
  } finally {
    daemon.kill('SIGTERM');
    await sleep(1000);
  }
}

try {
  // ---- boot 1: the sweep heals the imported book -------------------------
  await withDaemon(async (call, daemonStderr, port) => {
    // This pre-hierarchy fixture has no Human/root marker or delegation cert.
    // The PACKED production artifact must keep its packet unexposed while it
    // reports the record quarantined. The blocked candidate logged EXPOSED here,
    // then told the management surface the same packet was unbindable quarantine.
    const beforeRoot = daemonStderr();
    ok(/\[BookKeeper\] RESTORED IN QUARANTINE \(no routing\/broker registration\)/.test(beforeRoot),
      'packed artifact: legacy packet remains in private restore quarantine before a Human/root exists');
    ok(!/\[BookKeeper\] EXPOSED \(routing \+ broker registration\)/.test(beforeRoot),
      'packed artifact: stderr never contradicts quarantine by exposing/registering the legacy flat packet');
    const quarantined = await fetch(`http://127.0.0.1:${port}/identities`).then((r) => r.json());
    const row = quarantined.identities.find((i) => i.name === 'BookKeeper');
    ok(JSON.stringify(row) === JSON.stringify({ name: 'BookKeeper', status: 'quarantined' }),
      'management API exposes only the name-level quarantined row (no kind/CID/routing/lease metadata)');
    const unread = await fetch(`http://127.0.0.1:${port}/unread`).then((r) => r.json());
    ok(!unread.identities.some((i) => i.name === 'BookKeeper'),
      'quarantined legacy state has no unread/notification summary surface');
    const notifications = await fetch(`http://127.0.0.1:${port}/identities/BookKeeper/notifications?since=tip`);
    ok(notifications.status === 404, 'quarantined legacy state has no notification stream');

    // Exercise the supported explicit migration path before using the restored role.
    const human = await call('create_root_identity', { name: 'FixtureHuman', expose_local: false });
    if (human.isError) throw new Error(`could not establish fixture Human/root: ${human.text}`);
    const afterRoot = daemonStderr();
    const delegatedAt = afterRoot.indexOf('[BookKeeper] delegated as a role under root "FixtureHuman"');
    const exposedAt = afterRoot.indexOf('[BookKeeper] EXPOSED (routing + broker registration) — hierarchy reconciliation complete');
    ok(delegatedAt >= 0 && exposedAt > delegatedAt,
      'packed artifact: delegation is durably observed before the restored packet crosses the exposure barrier');
    const migrated = await fetch(`http://127.0.0.1:${port}/identities`).then((r) => r.json());
    ok(migrated.identities.some((i) => i.name === 'BookKeeper' && i.kind === 'role' && i.root === 'FixtureHuman'),
      'management API exposes the restored record only after it is a delegated role');
    await call('choose_identity', { name: 'BookKeeper', force: true });
    const book = (await call('list_contacts')).text;
    ok(new RegExp(`• Twin — ${keeper}`).test(book), 'boot 1: the LOWEST container id (byte order) keeps the bare "Twin"');
    ok(new RegExp(`• Twin 1 — ${renamed}`).test(book), 'boot 1: the other duplicate became "Twin 1"');
    ok(book.includes(meta.twin_cids[0]) && book.includes(meta.twin_cids[1]), 'boot 1: nothing was deleted — both container ids survive');
    ok(!/DUPLICATE NAME/.test(book), 'boot 1: no duplicate-name marker remains after the sweep');
    ok(!/keys pending restore/.test(book), 'boot 1: neither contact is degraded — peer_ads survived the sweep');
    const renLine = book.split('\n').find((l) => l.includes(renamed)) ?? '';
    ok(/renamed on import/.test(renLine) && /"Twin"/.test(renLine), 'boot 1: the renamed entry carries the renamed-on-import mark');
    const keepLine = book.split('\n').find((l) => l.includes(`• Twin — ${keeper}`)) ?? '';
    ok(!/renamed on import/.test(keepLine), 'boot 1: the keeper carries no mark');
  });

  // ---- boot 2: repeated imports are STABLE -------------------------------
  await withDaemon(async (call, daemonStderr) => {
    const boot2 = daemonStderr();
    const delegatedAt = boot2.indexOf('[BookKeeper] delegated as a role under root "FixtureHuman"');
    const exposedAt = boot2.indexOf('[BookKeeper] EXPOSED (routing + broker registration) — hierarchy reconciliation complete');
    ok(delegatedAt >= 0 && exposedAt > delegatedAt,
      'boot 2 packed artifact: restored role refreshes its delegation before broker registration');
    await call('choose_identity', { name: 'BookKeeper', force: true });
    const book = (await call('list_contacts')).text;
    ok(new RegExp(`• Twin — ${keeper}`).test(book) && new RegExp(`• Twin 1 — ${renamed}`).test(book),
      'boot 2: names identical after a second import of the healed book');
    ok(!/Twin 2/.test(book), 'boot 2: no ordinal creep ("Twin 2") across repeated imports');
    ok(/renamed on import/.test(book), 'boot 2: the renamed-on-import mark PERSISTED across the restart');

    // The operator settles the name: rename by container id clears the mark.
    const ren = await call('rename_contact', { contact: renamed, name: 'TwinLive' });
    ok(!ren.isError, 'settle: rename_contact by container id succeeds on the healed book');
    const book2 = (await call('list_contacts')).text;
    ok(new RegExp(`• TwinLive — ${renamed}`).test(book2) && !/renamed on import/.test(book2),
      'settle: the mark clears once the operator renames the contact');
  });
} catch (err) {
  fail += 1;
  console.error('  ✗ SUITE ERROR:', err);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\ncontact-uniqueness import sweep: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
