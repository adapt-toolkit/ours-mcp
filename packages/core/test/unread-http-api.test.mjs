import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'dist', 'cli.js');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const freePort = () => new Promise((resolve, reject) => {
  const server = createServer();
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

const port = await freePort();
const stateDir = mkdtempSync(join(tmpdir(), 'ours-unread-api-'));
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

try {
  const deadline = Date.now() + 20_000;
  let up = false;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/version`)).ok) { up = true; break; }
    } catch {}
    await sleep(100);
  }
  assert.equal(up, true, 'daemon starts');
  const token = readFileSync(join(stateDir, 'daemon-token'), 'utf8').trim();
  mkdirSync(join(stateDir, 'Alice'), { recursive: true });
  writeFileSync(join(stateDir, 'Alice', 'unread.json'), JSON.stringify({
    count: 2,
    recent: [{ from: 'Bob', msg_id: 7, date: '2026-07-15T00:00:00.000Z' }],
    files: 1,
    unread_files: [{ from: 'Bob', filename: 'report.pdf', mime: 'application/pdf', wire_id: 'wire-1' }],
    forbidden_body: 'secret body',
  }));
  mkdirSync(join(stateDir, 'Empty'), { recursive: true });
  writeFileSync(join(stateDir, 'Empty', 'unread.json'), JSON.stringify({ count: 0, recent: [], files: 0, unread_files: [] }));

  const unauth = await fetch(`http://127.0.0.1:${port}/unread`);
  assert.equal(unauth.status, 401);

  const response = await fetch(`http://127.0.0.1:${port}/unread`, {
    headers: { 'x-ours-api-token': token },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, {
    identities: [{
      name: 'Alice',
      count: 2,
      recent: [{ from: 'Bob', msg_id: 7, date: '2026-07-15T00:00:00.000Z' }],
      files: 1,
      unread_files: [{ from: 'Bob', filename: 'report.pdf', mime: 'application/pdf', wire_id: 'wire-1' }],
    }],
  });
  assert.doesNotMatch(JSON.stringify(body), /secret body/);
  console.log('unread HTTP API: pass');
} finally {
  try { process.kill(-daemon.pid, 'SIGKILL'); } catch {}
  rmSync(stateDir, { recursive: true, force: true });
}
