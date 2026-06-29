#!/usr/bin/env node
// remove_contact e2e (issue #4): remove → re-add → send round-trip, plus that
// removal blocks both directions (outbound send fails, inbound send is rejected
// at the contacts gate). Runs against the dev broker in an ISOLATED state dir,
// asserting it is never the production ~/.ours.
//
// Prereq: broker on ws://localhost:9000, built bundle (cd plugin && npm run build).

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import * as fs from 'node:fs';

const PLUGIN_DIST = resolve('packages/core/dist/index.js');
const BROKER_URL = 'ws://localhost:9000';
const STATE_DIR = '/tmp/ours-rc-test';

if (resolve(STATE_DIR) === resolve(homedir(), '.ours')) {
  console.error('REFUSING: test state dir must not be the production ~/.ours');
  process.exit(1);
}

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
    initialize: () => send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test-remove-contact', version: '0.0.1' } }),
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
const inviteBlob = (out) => out.match(/\n\n(.+)$/s)?.[1]?.trim();

async function main() {
  console.log('=== ours remove_contact e2e ===\n');
  fs.rmSync(STATE_DIR, { recursive: true, force: true });

  const c = createClient();
  await c.initialize();

  console.log('--- setup: Alice + Bob, mutually connected ---');
  assert(/Created identity "Alice"/.test(await c.call('create_identity', { name: 'Alice', expose_local: false })), 'created Alice');
  const blob1 = inviteBlob(await c.call('generate_invite', { name: 'Bob' }));
  assert(!!blob1, 'Alice generated invite #1 for Bob');
  assert(/^[A-Za-z0-9_-]+$/.test(blob1), 'invite #1 is single-line base64url (no +/=, no whitespace)');
  assert(/Created identity "Bob"/.test(await c.call('create_identity', { name: 'Bob', expose_local: false })), 'created Bob (now bound)');
  assert(/Added contact "Alice"/.test(await c.call('add_contact', { invite: blob1 })), 'Bob added Alice from invite #1');
  console.log('  waiting 5s for handshake + accept round trip…');
  await sleep(5000);
  await c.call('choose_identity', { name: 'Alice' });
  assert(/Bob/.test(await c.call('list_contacts')), 'Alice learned Bob (accept routed)');

  console.log('--- sanity: Bob → Alice message flows before removal ---');
  await c.call('choose_identity', { name: 'Bob' });
  await c.call('send_message', { contact: 'Alice', text: 'pre-remove-msg' });
  await sleep(3000);
  await c.call('choose_identity', { name: 'Alice' });
  assert(/pre-remove-msg/.test(await c.call('list_incoming_messages')), 'Alice received the pre-remove message');

  console.log('--- remove: Bob removes Alice ---');
  await c.call('choose_identity', { name: 'Bob' });
  assert(/Removed contact "Alice"/.test(await c.call('remove_contact', { contact: 'Alice' })), 'remove_contact reports Alice removed');
  assert(!/Alice/.test(await c.call('list_contacts')), "Alice is gone from Bob's contacts");

  console.log('--- removal blocks both directions ---');
  assert(/not a contact and has no local contact-book entry/.test(await c.call('send_message', { contact: 'Alice', text: 'should-not-send' })), 'Bob can no longer send to removed Alice (outbound blocked; no book entry to fall back to)');
  await c.call('choose_identity', { name: 'Alice' });
  await c.call('send_message', { contact: 'Bob', text: 'should-be-rejected' });
  await sleep(3000);
  await c.call('choose_identity', { name: 'Bob' });
  assert(!/should-be-rejected/.test(await c.call('list_incoming_messages')), 'Alice→Bob message rejected at Bob after removal (inbound blocked)');

  console.log('--- re-add: Bob re-adds Alice via a fresh invite ---');
  await c.call('choose_identity', { name: 'Alice' });
  const blob2 = inviteBlob(await c.call('generate_invite', { name: 'Bob' }));
  assert(!!blob2, 'Alice generated invite #2 (re-add)');
  const blob2Pasted = blob2.slice(0, 12) + '\n   ' + blob2.slice(12);
  await c.call('choose_identity', { name: 'Bob' });
  assert(/Added contact "Alice"/.test(await c.call('add_contact', { invite: blob2Pasted })), 'Bob re-added Alice from a whitespace-corrupted invite (armor strips newlines on decode)');
  console.log('  waiting 5s for re-add round trip…');
  await sleep(5000);
  assert(/Alice/.test(await c.call('list_contacts')), "Alice is back in Bob's contacts");

  console.log('--- send after re-add (the round-trip) ---');
  await c.call('send_message', { contact: 'Alice', text: 'after-readd-msg' });
  await sleep(3000);
  await c.call('choose_identity', { name: 'Alice' });
  assert(/after-readd-msg/.test(await c.call('list_incoming_messages')), 'Bob→Alice message after re-add ROUND-TRIPS (dangling key_storage state did not break it)');

  c.kill();
  await sleep(1000);
  console.log('\n=== REMOVE_CONTACT TEST PASSED ===');
}

main().catch((err) => {
  console.error('\nREMOVE_CONTACT TEST FAILED:', err.message);
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 500);
});
