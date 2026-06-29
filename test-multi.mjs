#!/usr/bin/env node
// Multi-container e2e test (new two-layer model): ONE MCP server process hosts
// TWO identities (Alice + Bob) in a single ADAPT wrapper. Exercises the global
// identity layer (create/choose/list/current) + the per-container messaging
// layer, the exclusive session binding, and persistence across a restart.
//
// A single stdio session binds one identity at a time, so we switch the binding
// with choose_identity to drive each side. Both packets stay live in the wrapper
// regardless of which one the session is bound to, so mail is delivered to the
// right packet either way.
//
// Prereq: broker on ws://localhost:9000, built bundle (cd plugin && npm run build).

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import * as fs from 'node:fs';

const PLUGIN_DIST = resolve('packages/core/dist/index.js');
const BROKER_URL = 'ws://localhost:9000';
const STATE_DIR = resolve(homedir(), '.ours-multi-test');

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
    initialize: () => send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test-multi', version: '0.0.1' } }),
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

async function main() {
  console.log('=== ours multi-container e2e test ===\n');
  fs.rmSync(STATE_DIR, { recursive: true, force: true });

  // ---- Phase 1: two identities in one process ----
  console.log('--- Phase 1: create + message ---');
  let c = createClient();
  await c.initialize();

  const noBound = await c.call('list_contacts');
  assert(/No identity bound/.test(noBound), 'per-container call with no bound identity errors cleanly');

  assert(/Created identity "Alice"/.test(await c.call('create_identity', { name: 'Alice' })), 'created Alice (auto-bound)');
  assert(/Alice/.test(await c.call('current_identity')), 'current_identity reports Alice');

  const invite = await c.call('generate_invite', { name: 'Bob' });
  const blob = invite.match(/\n\n(.+)$/s)?.[1]?.trim();
  assert(!!blob, 'Alice generated an invite blob for Bob');
  const inviteBytes = Buffer.from(blob, 'base64').length;
  console.log(`  invite size: ${inviteBytes} bytes raw / ${blob.length} base64 chars (slim _write was 1448 raw; pre-slim 2423)`);
  assert(inviteBytes < 800, `invite is slim + compressed (${inviteBytes} bytes, was 2423)`);
  // Sanity: the compressed blob still round-trips through add_contact (below).

  assert(/Created identity "Bob"/.test(await c.call('create_identity', { name: 'Bob' })), 'created Bob (binding switches to Bob)');
  assert(/Added contact "Alice"/.test(await c.call('add_contact', { invite: blob })), 'Bob added Alice from the invite');
  console.log('  waiting 5s for handshake + accept round trip…');
  await sleep(5000);

  await c.call('choose_identity', { name: 'Alice' });
  assert(/Bob/.test(await c.call('list_contacts')), 'Alice learned Bob (accept routed across the wrapper)');

  await c.call('send_message', { contact: 'Bob', text: 'msg1-alice-to-bob' });
  await sleep(3000);

  await c.call('choose_identity', { name: 'Bob' });
  assert(/msg1-alice-to-bob/.test(await c.call('list_incoming_messages')), 'Bob received msg1');
  const got1 = await c.call('get_messages');
  assert(/1 new message/.test(got1) && /msg1-alice-to-bob/.test(got1), 'get_messages surfaces 1 new for Bob (with body)');
  // #wire_id: every message carries a stable cross-side wire id, surfaced as {…}.
  const wire1 = (got1.match(/\{([^}]+)\}/) || [])[1];
  assert(!!wire1, `get_messages surfaces msg1's wire_id (${wire1})`);
  assert(/No new messages/.test(await c.call('get_messages')), 'second get_messages shows nothing new (msg1 now read)');
  // #3: the body must NOT be on disk — notifications.log is content-free.
  {
    const notif = fs.readFileSync(resolve(STATE_DIR, 'Bob', 'notifications.log'), 'utf8');
    assert(!/msg1-alice-to-bob/.test(notif) && /message_received/.test(notif), 'notifications.log records the event but NOT the body');
    assert(!fs.existsSync(resolve(STATE_DIR, 'Bob', 'inbox.log')), 'no legacy inbox.log written');
  }

  // #reply_to: Bob replies to msg1, citing its wire_id + sentence 1.
  const sentReply = await c.call('send_message', {
    contact: 'Alice',
    text: 'reply1-bob-to-alice',
    reply_to_wire_id: wire1,
    reply_to_sentence: 1,
  });
  assert(/wire_id/.test(sentReply), 'send_message reports the reply\'s own wire_id');
  await sleep(3000);
  await c.call('choose_identity', { name: 'Alice' });
  const aliceInbox = await c.call('list_incoming_messages');
  assert(/reply1-bob-to-alice/.test(aliceInbox), 'Alice received the reply');
  assert(
    aliceInbox.includes(`↳re ${wire1}·s1`),
    'the reply carries a reply_to pointer at msg1\'s wire_id + sentence 1',
  );

  assert(/Identities \(2\)/.test(await c.call('list_identities')), 'list_identities shows both identities in one wrapper');

  c.kill();
  await sleep(1500); // flush state
  console.log('  phase-1 process stopped (state flushed).\n');

  // ---- Phase 2: restart, same state dir ----
  console.log('--- Phase 2: restart + persistence ---');
  c = createClient();
  await c.initialize();

  const ids = await c.call('list_identities');
  assert(/Alice/.test(ids) && /Bob/.test(ids), 'both identities restored after restart');

  await c.call('choose_identity', { name: 'Bob' });
  assert(/Alice/.test(await c.call('list_contacts')), "Bob's contact (Alice) survived the restart");
  assert(/msg1-alice-to-bob/.test(await c.call('list_incoming_messages')), "Bob's inbox survived the restart");

  // The real proof: the encrypted channel was rebuilt from imported peer keys.
  await c.call('choose_identity', { name: 'Alice' });
  await c.call('send_message', { contact: 'Bob', text: 'msg2-after-restart' });
  await sleep(3000);
  await c.call('choose_identity', { name: 'Bob' });
  assert(/msg2-after-restart/.test(await c.call('list_incoming_messages')), 'new message flows after restart (channel rebuilt from import_state)');

  // ---- Phase 3: read / defer lifecycle (two-generation GC) ----
  console.log('--- Phase 3: read/defer lifecycle ---');
  // msg1 is already "processed" (drained in phase 1); msg2 is the only unread one.
  const drain2 = await c.call('get_messages');
  assert(/1 new message/.test(drain2) && /msg2-after-restart/.test(drain2), 'get_messages returns only the unread msg2 (msg1 stays processed, not re-delivered)');
  const id2 = parseInt(drain2.match(/#(\d+)/)[1], 10);

  // defer it back → a subsequent get_messages re-surfaces it (postpone for another session).
  assert(/Deferred 1/.test(await c.call('defer_messages', { msg_ids: [id2] })), 'defer_messages flips msg2 back to unread');
  assert(/msg2-after-restart/.test(await c.call('get_messages')), 'deferred msg2 is delivered again');

  // get_messages finalizes to "processed"; this test runs the default (1h) GC
  // interval, so no tick fires — both stay in the inbox as processed and neither
  // is re-delivered. (The GC lifecycle itself is covered by test-gc.mjs.)
  assert(/No new messages/.test(await c.call('get_messages')), 'processed msg2 is not re-delivered');
  const finalInbox = await c.call('list_incoming_messages');
  assert(/msg2-after-restart/.test(finalInbox) && /\[processed\]/.test(finalInbox), 'msg2 remains in the inbox as processed (awaiting GC)');
  assert(/msg1-alice-to-bob/.test(finalInbox), 'previously-read msg1 still in the inbox');

  // ---- remove_identity ----
  console.log('--- Phase 4: remove_identity ---');
  assert(/Removed identity "Bob"/.test(await c.call('remove_identity', { name: 'Bob' })), 'removed Bob');
  assert(!/Bob/.test(await c.call('list_identities')), 'Bob no longer listed');
  assert(!fs.existsSync(resolve(STATE_DIR, 'Bob')), "Bob's state dir deleted");

  c.kill();
  await sleep(1000);
  console.log('\n=== MULTI-CONTAINER TEST PASSED ===');
}

main().catch((err) => {
  console.error('\nMULTI-CONTAINER TEST FAILED:', err.message);
  process.exitCode = 1;
  // Don't hang waiting on the child MCP server when an assertion throws.
  setTimeout(() => process.exit(1), 500);
});
