// packages/core/test/create-root-cli.test.mjs
// `ours-mcp create-root "<name>"` — the deterministic CLI path the installer uses to create THE
// root human identity at first install (no agent/skill in the loop). It drives the running
// daemon's existing create_root_identity MCP tool over loopback HTTP. Semantics under test:
//   • no name → usage + exit 1
//   • first call → creates the root, exit 0
//   • a root already exists (different name) → SKIP quietly, exit 0 (idempotent for installers)
//   • same NAME already exists as an identity → real error, exit 1
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'dist', 'cli.js');
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓', m)) : (fail++, console.log('  ✗ FAIL:', m)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });

const dir = mkdtempSync(join(tmpdir(), 'a2a-croot-'));
const PORT = await freePort();
const ENV = { ...process.env, OURS_PORT: String(PORT), OURS_STATE_DIR: dir, OURS_BROKER_URL: 'wss://invalid.local/none' };

// Run the CLI, capturing stdout+stderr and the exit code (execFileSync throws on non-zero).
function cli(args) {
  try {
    const out = execFileSync('node', [CLI, ...args], { env: ENV, encoding: 'utf8', stdio: 'pipe', timeout: 30_000 });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

const daemon = spawn('node', [CLI, 'serve'], { env: { ...ENV, OURS_TRANSPORT: 'http' }, stdio: 'ignore' });
try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/version`)).ok) break; } catch {} await sleep(250); }

  const noName = cli(['create-root']);
  ok(noName.code === 1 && /usage/i.test(noName.out), 'no name → usage + exit 1');

  const first = cli(['create-root', 'Test Owner']);
  ok(first.code === 0, 'first create-root exits 0');
  ok(/Created root identity "Test Owner"/.test(first.out), 'reports the created root');
  ok(!/Ask the user/.test(first.out), 'agent-directed monitor hint is stripped from CLI output');

  const second = cli(['create-root', 'Someone Else']);
  ok(second.code === 0, 'a pre-existing root is a quiet no-op (exit 0) — installers stay idempotent');
  ok(/already exists/.test(second.out), 'the no-op says a root already exists');

  const dupName = cli(['create-root', 'Test Owner']);
  ok(dupName.code === 1, 'an identity-name collision is a real error (exit 1)');
} finally {
  daemon.kill('SIGTERM');
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
