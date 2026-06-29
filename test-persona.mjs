#!/usr/bin/env node
// e2e for the local `persona` field: set_persona persists it, current_identity
// surfaces it alongside bio, it survives a daemon restart, and bio still works.
// Prereq: built bundle (npm run build --workspace @ours.network/mcp).
// No broker handshake is exercised; if the daemon refuses to boot without a
// broker, start the dev broker on ws://localhost:9000 first.

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import * as fs from 'node:fs';

const PLUGIN_DIST = resolve('packages/core/dist/index.js');
const BROKER_URL = 'ws://localhost:9000';
const STATE_DIR = resolve(homedir(), '.ours-persona-test');

function createClient() {
  const child = spawn('node', [PLUGIN_DIST], {
    env: { ...process.env, OURS_STATE_DIR: STATE_DIR, OURS_BROKER_URL: BROKER_URL, OURS_TRANSPORT: 'stdio' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '';
  const pending = new Map();
  let nextId = 1;
  child.stderr.on('data', (d) => { if (process.env.VERBOSE) process.stderr.write(`[srv] ${d}`); });
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try { const msg = JSON.parse(line); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } } catch {}
    }
  });
  function send(method, params = {}) {
    return new Promise((res, rej) => {
      const id = nextId++;
      const timer = setTimeout(() => { pending.delete(id); rej(new Error(`${method} timed out`)); }, 40_000);
      pending.set(id, (msg) => { clearTimeout(timer); msg.error ? rej(new Error(`${method} → ${JSON.stringify(msg.error)}`)) : res(msg.result); });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  return {
    initialize: () => send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test-persona', version: '0.0.1' } }),
    call: async (name, args = {}) => { const res = await send('tools/call', { name, arguments: args }); return res?.content?.[0]?.text ?? JSON.stringify(res); },
    kill: () => child.kill('SIGTERM'),
  };
}

const assert = (cond, msg) => { if (!cond) throw new Error(`ASSERT FAILED: ${msg}`); console.log(`  ✓ ${msg}`); };

async function main() {
  console.log('=== ours persona e2e ===\n');
  fs.rmSync(STATE_DIR, { recursive: true, force: true });

  let c = createClient();
  await c.initialize();

  assert(/Created identity "Worker"/.test(await c.call('create_identity', { name: 'Worker', bio: 'Public card: build worker.' })), 'created Worker with a bio');

  const set = await c.call('set_persona', { persona: 'You are a focused build worker. Do not touch deploys.' });
  assert(/Updated the persona of "Worker"/.test(set), 'set_persona succeeds');

  const ci = await c.call('current_identity');
  assert(/Public card: build worker\./.test(ci), 'current_identity still shows the bio');
  assert(/Persona: You are a focused build worker\. Do not touch deploys\./.test(ci), 'current_identity surfaces the persona');

  c.kill();
  await new Promise((r) => setTimeout(r, 500));

  // Restart: persona must survive via core state export/import.
  c = createClient();
  await c.initialize();
  const chose = await c.call('choose_identity', { name: 'Worker' });
  assert(/Worker/.test(chose) && !/error|not found|No identity bound/i.test(chose), 'chose Worker after restart (no error)');
  const ci2 = await c.call('current_identity');
  assert(/Persona: You are a focused build worker\. Do not touch deploys\./.test(ci2), 'persona persists across a daemon restart');
  c.kill();

  console.log('\n=== persona e2e PASSED ===');
}
main().catch((e) => { console.error('\n' + e.stack); process.exit(1); });
