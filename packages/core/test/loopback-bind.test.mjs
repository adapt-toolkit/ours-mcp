import { spawn } from 'node:child_process';
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

const dir = mkdtempSync(join(tmpdir(), 'a2a-loop-'));
const PORT = await freePort();
const daemon = spawn('node', [CLI, 'serve'], { env: { ...process.env, OURS_TRANSPORT: 'http', OURS_PORT: String(PORT), OURS_STATE_DIR: dir, OURS_BROKER_URL: 'wss://invalid.local/none' }, stdio: 'ignore' });
try {
  // wait for the port
  for (let i = 0; i < 60; i++) { try { await fetch(`http://127.0.0.1:${PORT}/version`); break; } catch { await sleep(250); } }
  const onLoopback = await fetch(`http://127.0.0.1:${PORT}/version`).then((r) => r.ok).catch(() => false);
  ok(onLoopback, 'daemon answers /version on 127.0.0.1');
} finally {
  daemon.kill('SIGTERM');
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
