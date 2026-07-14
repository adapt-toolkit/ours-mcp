import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { connectAppServer } from '../src/app-server-client.mjs';

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitReady(url, child) {
  for (let i = 0; i < 100; i += 1) {
    if (child.exitCode != null) throw new Error(`app-server exited ${child.exitCode}`);
    try { if ((await fetch(`${url.replace(/^ws/, 'http')}/readyz`)).ok) return; } catch { /* startup */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('app-server readiness timed out');
}

test('installed Codex shares an externally started turn across App Server clients', { skip: process.env.OURS_CODEX_LIVE_TEST !== '1', timeout: 120_000 }, async () => {
  const url = `ws://127.0.0.1:${await freePort()}`;
  const child = spawn('codex', ['app-server', '--listen', url], { stdio: ['ignore', 'ignore', 'inherit'] });
  let owner; let watcher;
  try {
    await waitReady(url, child);
    owner = await connectAppServer(url, { timeoutMs: 60_000 });
    watcher = await connectAppServer(url, { timeoutMs: 60_000 });
    const ownerEvents = []; const watcherEvents = [];
    owner.onNotification((message) => ownerEvents.push(message));
    watcher.onNotification((message) => watcherEvents.push(message));
    const started = await owner.request('thread/start', { cwd: process.cwd(), approvalPolicy: 'never' });
    const threadId = started.thread.id;
    await watcher.startTurn(threadId, 'Reply with exactly OURS_CODEX_WAKE_OK. Do not use tools.');
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline && !ownerEvents.some((message) => message.method === 'turn/completed')) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(ownerEvents.some((message) => message.method === 'turn/started'), 'second client sees externally started visible turn');
    assert.ok(ownerEvents.some((message) => message.method === 'turn/completed'), 'second client sees externally started turn complete');
    const read = await watcher.readThread(threadId);
    assert.ok(read.thread.turns.some((turn) => turn.status === 'completed'), 'monitor client can observe completion via thread/read');
  } finally {
    owner?.close(); watcher?.close();
    if (child.exitCode == null) child.kill('SIGTERM');
    if (child.exitCode == null) await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 3000))]);
  }
});
