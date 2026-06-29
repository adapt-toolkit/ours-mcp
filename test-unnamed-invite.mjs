#!/usr/bin/env node
// E2e test for optional invite names: an invite generated WITHOUT a name
// registers the redeemer under the name they announce when accepting, while a
// named invite keeps pinning the inviter-assigned name (regression guard).
//
// Prereq: broker on ws://localhost:9000, built bundle (cd plugin && npm run build).

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import * as fs from 'node:fs';

const PLUGIN_DIST = resolve('packages/core/dist/index.js');
const BROKER_URL = 'ws://localhost:9000';
const STATE_DIR = resolve(homedir(), '.ours-unnamed-invite-test');

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
      try {
        const msg = JSON.parse(line);
        if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
      } catch {}
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
    child,
    initialize: () => send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test-unnamed-invite', version: '0.0.1' } }),
    call: async (name, args = {}) => {
      const res = await send('tools/call', { name, arguments: args });
      return res?.content?.[0]?.text ?? JSON.stringify(res);
    },
    kill: () => child.kill('SIGTERM'),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}
const extractBlob = (inviteText) => inviteText.match(/\n\n(.+)$/s)?.[1]?.trim();

async function main() {
  console.log('=== ours unnamed-invite e2e test ===\n');
  fs.rmSync(STATE_DIR, { recursive: true, force: true });

  const c = createClient();
  await c.initialize();

  assert(/Created identity "Alice"/.test(await c.call('create_identity', { name: 'Alice' })), 'created Alice');

  console.log('--- unnamed invite: redeemer name wins ---');
  const unnamed = await c.call('generate_invite');
  assert(/name the recipient announces/.test(unnamed), 'unnamed invite result explains the redeemer-name behavior');
  const unnamedBlob = extractBlob(unnamed);
  assert(!!unnamedBlob, 'unnamed invite carries a blob');

  assert(/Created identity "Bob"/.test(await c.call('create_identity', { name: 'Bob' })), 'created Bob (binding switches to Bob)');
  assert(/Added contact "Alice"/.test(await c.call('add_contact', { invite: unnamedBlob })), 'Bob redeemed the unnamed invite');
  console.log('  waiting 5s for handshake + accept round trip…');
  await sleep(5000);

  await c.call('choose_identity', { name: 'Alice' });
  const contacts1 = await c.call('list_contacts');
  assert(/• Bob — /.test(contacts1), 'Alice registered the redeemer under his announced name "Bob"');

  console.log('--- named invite: assigned name still wins (regression) ---');
  const named = await c.call('generate_invite', { name: 'Robert' });
  assert(/Invite for "Robert" created/.test(named), 'named invite result names the peer');
  const namedBlob = extractBlob(named);
  assert(!!namedBlob, 'named invite carries a blob');

  assert(/Created identity "Carol"/.test(await c.call('create_identity', { name: 'Carol' })), 'created Carol');
  assert(/Added contact "Alice"/.test(await c.call('add_contact', { invite: namedBlob })), 'Carol redeemed the named invite');
  console.log('  waiting 5s for handshake + accept round trip…');
  await sleep(5000);

  await c.call('choose_identity', { name: 'Alice' });
  const contacts2 = await c.call('list_contacts');
  assert(/• Robert — /.test(contacts2), 'Alice registered Carol under the assigned name "Robert"');
  assert(!/• Carol — /.test(contacts2), 'the announced name did not override the assigned one');

  console.log('--- messaging works over the unnamed-invite contact ---');
  await c.call('send_message', { contact: 'Bob', text: 'hello-bob-unnamed' });
  await sleep(3000);
  await c.call('choose_identity', { name: 'Bob' });
  assert(/hello-bob-unnamed/.test(await c.call('list_incoming_messages')), 'Bob received a message addressed via the announced name');

  c.kill();
  await sleep(1000);
  fs.rmSync(STATE_DIR, { recursive: true, force: true });
  console.log('\n=== UNNAMED-INVITE TEST PASSED ===');
}

main().catch((err) => {
  console.error('\nUNNAMED-INVITE TEST FAILED:', err.message);
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 500);
});
