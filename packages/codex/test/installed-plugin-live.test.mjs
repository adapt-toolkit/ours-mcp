import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { connectAppServer } from '../src/app-server-client.mjs';

async function port() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const value = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return value;
}

test('locally installed native plugin exposes both MCP servers', { skip: process.env.OURS_CODEX_INSTALLED_TEST !== '1', timeout: 30_000 }, async () => {
  const url = `ws://127.0.0.1:${await port()}`;
  const child = spawn('codex', ['app-server', '--listen', url], { stdio: ['ignore', 'ignore', 'inherit'] });
  let client;
  try {
    for (let i = 0; i < 100; i += 1) {
      try { if ((await fetch(`${url.replace(/^ws/, 'http')}/readyz`)).ok) break; } catch { /* startup */ }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    client = await connectAppServer(url, { timeoutMs: 20_000 });
    const status = await client.request('mcpServerStatus/list', { detail: 'full' });
    const ours = status.data.find((server) => server.name === 'ours');
    const monitor = status.data.find((server) => server.name === 'ours_monitor');
    assert.ok(ours, `ours server missing; found: ${status.data.map((server) => server.name).join(', ')}`);
    assert.ok(monitor, `ours_monitor missing; found: ${status.data.map((server) => server.name).join(', ')}`);
    assert.deepEqual(Object.keys(monitor.tools).sort(), ['arm_monitor', 'disarm_monitor', 'monitor_status'], JSON.stringify(monitor));
  } finally {
    client?.close(); if (child.exitCode == null) child.kill('SIGTERM');
    if (child.exitCode == null) await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 3000))]);
  }
});
