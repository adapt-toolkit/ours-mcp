#!/usr/bin/env node
// Local contact book e2e test: one MCP server process, several identities in one
// wrapper, exercising
//   1. the accept_contact security fix (a redeemed invite cannot be reused),
//   2. the inviteless send_message fallback through the local contact book
//      (registrar-minted introduction + first message in one transaction),
//   3. consent policy (local_auto_accept=false → pending introduction, queued
//      messages, approve flushes / reject drops),
//   4. exposure control (set_local_book_policy expose=false unpublishes),
//   5. restart persistence (registrar + pins + book survive a daemon restart),
//   6. tamper-evidence (a corrupted book entry fails registrar verification).
//
// Prereq: broker on ws://localhost:9000, built bundle (cd plugin && npm run build).

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import * as fs from 'node:fs';

const PLUGIN_DIST = resolve('packages/core/dist/index.js');
const BROKER_URL = 'ws://localhost:9000';
const STATE_DIR = resolve(homedir(), '.ours-book-test');

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
    initialize: () => send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test-contact-book', version: '0.0.1' } }),
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
  console.log('=== ours local contact book e2e test ===\n');
  fs.rmSync(STATE_DIR, { recursive: true, force: true });

  let c = createClient();
  await c.initialize();

  // ---- Phase 1: redeemed invites are single-use (accept_contact fix) ----
  console.log('--- Phase 1: invite reuse is rejected ---');
  await c.call('create_identity', { name: 'Alice' });
  const invite = await c.call('generate_invite', { name: 'Bob' });
  const blob = invite.match(/\n\n(.+)$/s)?.[1]?.trim();
  assert(!!blob, 'Alice generated an invite for Bob');

  await c.call('create_identity', { name: 'Bob' });
  assert(/Added contact "Alice"/.test(await c.call('add_contact', { invite: blob })), 'Bob redeemed the invite');
  await sleep(5000);

  await c.call('choose_identity', { name: 'Alice' });
  const aliceAfterBob = await c.call('list_contacts');
  assert(/Bob/.test(aliceAfterBob), 'Alice registered Bob');

  await c.call('create_identity', { name: 'Mallory', expose_local: false });
  await c.call('add_contact', { invite: blob }); // succeeds locally; Alice must reject it
  await sleep(5000);
  await c.call('choose_identity', { name: 'Alice' });
  const aliceAfterMallory = await c.call('list_contacts');
  assert(/Contacts \(1\)/.test(aliceAfterMallory), 'Alice still has exactly 1 contact — the reused invite was rejected');

  // ---- Phase 2: inviteless connect via the local contact book ----
  console.log('--- Phase 2: contact-book happy path ---');
  const book = await c.call('list_local_contact_book');
  assert(/Alice/.test(book) && /Bob/.test(book), 'Alice and Bob are published in the book');
  assert(!/Mallory/.test(book), 'Mallory (expose_local=false) is not in the book');

  await c.call('create_identity', { name: 'Carol' });
  const sendViaBook = await c.call('send_message', { contact: 'Alice', text: 'hi-from-carol-via-book' });
  assert(/connected via the local contact book/.test(sendViaBook), "Carol's send fell back to the book and connected");
  await sleep(5000);

  await c.call('choose_identity', { name: 'Alice' });
  const aliceGot = await c.call('get_messages');
  assert(/hi-from-carol-via-book/.test(aliceGot), 'Alice received the message that rode the introduction');
  assert(/Carol/.test(await c.call('list_contacts')), 'Alice auto-registered Carol (auto-accept default)');

  await c.call('send_message', { contact: 'Carol', text: 'reply-to-carol' });
  await sleep(3000);
  await c.call('choose_identity', { name: 'Carol' });
  assert(/reply-to-carol/.test(await c.call('get_messages')), 'Alice→Carol reply path works (symmetric contact)');

  // ---- Phase 3: consent — pending approval queue ----
  console.log('--- Phase 3: pending approval ---');
  await c.call('create_identity', { name: 'Dave', local_auto_accept: false });
  await c.call('choose_identity', { name: 'Carol' });
  await c.call('send_message', { contact: 'Dave', text: 'dave-msg-1' });
  await sleep(5000);
  await c.call('send_message', { contact: 'Dave', text: 'dave-msg-2' });
  await sleep(4000);

  await c.call('choose_identity', { name: 'Dave' });
  assert(/No new messages/.test(await c.call('get_messages')), 'Dave has nothing in his inbox while the introduction is pending');
  const daveContacts = await c.call('list_contacts');
  assert(/Pending local introductions \(1\)/.test(daveContacts) && /Carol/.test(daveContacts), 'Dave sees the pending introduction from Carol');
  assert(/2 queued/.test(daveContacts), 'both messages are queued on the pending introduction');
  {
    const notif = fs.readFileSync(resolve(STATE_DIR, 'Dave', 'notifications.log'), 'utf8');
    assert(/local_contact_request/.test(notif) && !/dave-msg-1/.test(notif), 'notifications.log has the request event but never a body');
  }

  const approved = await c.call('respond_to_introduction', { contact: 'Carol', action: 'approve' });
  assert(/Approved "Carol"/.test(approved) && /2 queued message/.test(approved), 'approval registered Carol and flushed the queue');
  const daveGot = await c.call('get_messages');
  assert(/dave-msg-1/.test(daveGot) && /dave-msg-2/.test(daveGot), 'Dave received both queued messages in order');

  // Reject path.
  await c.call('create_identity', { name: 'Eve', local_auto_accept: false });
  await c.call('choose_identity', { name: 'Carol' });
  await c.call('send_message', { contact: 'Eve', text: 'eve-msg' });
  await sleep(5000);
  await c.call('choose_identity', { name: 'Eve' });
  const rejected = await c.call('respond_to_introduction', { contact: 'Carol', action: 'reject' });
  assert(/Rejected the introduction from "Carol"/.test(rejected), 'Eve rejected the introduction');
  assert(/No new messages/.test(await c.call('get_messages')), "Eve's inbox stays empty after the reject");
  assert(!/Pending local introductions/.test(await c.call('list_contacts')), 'no pending introductions remain for Eve');

  // ---- Phase 4: exposure control ----
  console.log('--- Phase 4: unpublish ---');
  await c.call('choose_identity', { name: 'Alice' });
  await c.call('set_local_book_policy', { expose: false });
  assert(!/Alice/.test(await c.call('list_local_contact_book')), 'Alice unpublished from the book');
  await c.call('create_identity', { name: 'Frank' });
  const frankFail = await c.call('send_message', { contact: 'Alice', text: 'should-not-arrive' });
  assert(/no local contact-book entry/.test(frankFail), 'sending to an unpublished non-contact fails cleanly');

  // ---- Phase 5: restart persistence ----
  console.log('--- Phase 5: restart ---');
  c.kill();
  await sleep(2000);
  c = createClient();
  await c.initialize();
  await c.call('choose_identity', { name: 'Frank' });
  const afterRestart = await c.call('send_message', { contact: 'Bob', text: 'book-after-restart' });
  assert(/connected via the local contact book/.test(afterRestart), 'book path works after a restart (registrar restored from seed)');
  await sleep(5000);
  await c.call('choose_identity', { name: 'Bob' });
  assert(/book-after-restart/.test(await c.call('get_messages')), 'Bob received the post-restart book message');

  // ---- Phase 6: tampered book entry fails verification ----
  console.log('--- Phase 6: tamper-evidence ---');
  {
    const bookPath = resolve(STATE_DIR, 'contact-book', 'book.json');
    const parsed = JSON.parse(fs.readFileSync(bookPath, 'utf8'));
    assert(!!parsed.entries['Dave'], 'Dave has a book entry to tamper with');
    parsed.entries['Dave'].name = 'Dave-imposter';
    parsed.entries['Dave-imposter'] = parsed.entries['Dave'];
    delete parsed.entries['Dave'];
    fs.writeFileSync(bookPath, JSON.stringify(parsed, null, 2));
  }
  await c.call('choose_identity', { name: 'Frank' });
  // The stdlib's check_signature_new_container aborts on a bad signature (with
  // its own message) before our wrapper message can render — either way the
  // send must fail and never reach the target.
  const tampered = await c.call('send_message', { contact: 'Dave-imposter', text: 'evil' });
  assert(
    /failed registrar verification|Signature verifiction failed/.test(tampered) && /failed/.test(tampered),
    'a tampered book entry is rejected by the sender before connecting',
  );

  c.kill();
  fs.rmSync(STATE_DIR, { recursive: true, force: true });
  console.log('\n=== ALL CONTACT-BOOK TESTS PASSED ===');
}

main().catch((e) => {
  console.error(`\nFAILED: ${e.message}`);
  process.exit(1);
});
