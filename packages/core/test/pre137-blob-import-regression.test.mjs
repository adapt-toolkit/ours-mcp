// packages/core/test/pre137-blob-import-regression.test.mjs
//
// Pre-#137 (v0) blob import gate — GREEN since core b608099 (PR #14).
//
// Asserts restoreIdentity() against a genuinely pre-#137 identity blob (no
// format_version stamp): the old blob imports cleanly. Historically this was a
// KNOWN-RED tracking test: core 5887dec (what sdk/mufl 0.10.12 ships) had a
// ship-blocking regression — the $e2e_sessions `safe (...)` record-cast raised on
// the absent field (meta.mm's record path has no NIL branch) and restoreIdentity()
// caught it as a total loss of the identity's saved state. Fixed upstream by the
// NIL-guard in ours-mufl-core PR #14 (merge b608099), which this repo's
// packages/core/mufl_code/core submodule now pins; this file keeps guarding the
// path (nothing else in this repo exercises restoreIdentity() against an
// old-format blob at all). Wired into the default `npm test` chain since the fix
// landed. Standalone run:
//   node packages/core/test/pre137-blob-import-regression.test.mjs
// It is expected to flip green on its own, no local changes needed, once the upstream
// core fix lands and this repo's submodule is re-pinned past it — at that point fold
// it back into package.json's test chain and delete this header.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync, mkdirSync, copyFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'dist', 'cli.js');
const FIXTURE_STATE = join(HERE, 'fixtures', 'pre-137-identity-state.bin');
const FIXTURE_KEY = join(HERE, 'fixtures', 'pre-137-identity.key');
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓', m)) : (fail++, console.log('  ✗ FAIL:', m)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// OS-assigned port only — this MUST NEVER be a hardcoded/default port. A hardcoded
// port is exactly what let an earlier draft of this fixture-generation work slip a
// command onto the real live daemon (:3050) instead of an isolated instance; letting
// the OS pick makes that class of mistake structurally impossible, not just unlikely.
const freePort = () => new Promise((res, rej) => { const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });

const dir = mkdtempSync(join(tmpdir(), 'a2a-pre137-'));
const idDir = join(dir, 'FixtureAlice');
mkdirSync(idDir, { recursive: true });
copyFileSync(FIXTURE_STATE, join(idDir, 'state_data.bin'));
copyFileSync(FIXTURE_KEY, join(idDir, 'identity.key'));

const PORT = await freePort();
// Never a real broker — this test only cares about local restore-on-boot behavior.
const ENV = { ...process.env, OURS_TRANSPORT: 'http', OURS_PORT: String(PORT), OURS_STATE_DIR: dir, OURS_BROKER_URL: 'wss://invalid.local/none' };
const daemon = spawn('node', [CLI, 'serve'], { env: ENV, stdio: 'ignore' });
try {
  // bootWrapper restores every persisted identity BEFORE it starts the HTTP server
  // (see src/index.ts: the restore loop runs, then "starting HTTP server" logs), so
  // /version responding is already a reliable signal the restore attempt is done —
  // no fixed sleep needed/guessed at.
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/version`)).ok) break; } catch { /* not up yet */ } await sleep(250); }

  const daemonAlive = await fetch(`http://127.0.0.1:${PORT}/version`).then((r) => r.ok).catch(() => false);
  ok(daemonAlive, 'daemon comes up and stays up while restoring the pre-#137 blob');

  // Expected/correct behavior: the old blob imports cleanly, so NEITHER of these
  // failure artifacts should exist. Right now (core 5887dec) both do — that's the
  // known-red regression this file tracks.
  const notifyLog = join(idDir, 'notifications.log');
  const sawImportFailure = existsSync(notifyLog) && readFileSync(notifyLog, 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .some((ev) => ev.event === 'state_import_failed');
  ok(!sawImportFailure, 'no state_import_failed notification for the pre-#137 blob (the PR #14 NIL-guard keeps the import clean)');

  const preservedAsFailed = readdirSync(idDir).some((f) => f.startsWith('state_data.bin.failed-'));
  ok(!preservedAsFailed, 'state_data.bin was not sidelined to .failed-* (that rename only happens on import failure)');

  const token = readFileSync(join(dir, 'daemon-token'), 'utf8').trim();
  const identitiesUp = await fetch(`http://127.0.0.1:${PORT}/identities`, { headers: { Authorization: `Bearer ${token}` } })
    .then((r) => r.json()).catch(() => ({ identities: [] }));
  ok(Array.isArray(identitiesUp.identities) && identitiesUp.identities.some((i) => i.name === 'FixtureAlice'), 'FixtureAlice is present after restore (sanity: the identity itself always restores, only its saved state is at risk)');
} finally {
  daemon.kill('SIGTERM');
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
console.log(fail === 0
  ? '\n(GREEN — the upstream core fix has landed. Fold this file back into package.json\'s test chain and delete the known-red framing in the header.)'
  : '\n(EXPECTED RED right now — known upstream core issue in core 5887dec, see file header. Do not patch around it in this repo; re-run once the core submodule is re-pinned past the fix.)');
process.exit(fail ? 1 : 0);
