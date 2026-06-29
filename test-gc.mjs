#!/usr/bin/env node
// Two-generation GC e2e (issue #5). gc is host-fired on a timer, so this sets a
// short OURS_GC_INTERVAL_MS and lets the daemon's own timer drive the
// lifecycle, polling the readonly list_incoming_messages to observe it. Covers:
//   - get_messages flips unread -> processed (sole body egress, no ack needed)
//   - a processed message passes THROUGH ready_to_delete before deletion (i.e.
//     it survives >= 1 full cycle — two generations, not a one-shot delete)
//   - defer_messages restores from the ready_to_delete generation (the race the
//     two-generation design exists to win), and the message is re-delivered.
// Isolated state dir, asserted not to be the production ~/.ours.
//
// Prereq: broker on ws://localhost:9000, built bundle (cd plugin && npm run build).

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import * as fs from 'node:fs';

const PLUGIN_DIST = resolve('packages/core/dist/index.js');
const BROKER_URL = 'ws://localhost:9000';
const STATE_DIR = '/tmp/ours-gc-test';
const GC_MS = 2500;

if (resolve(STATE_DIR) === resolve(homedir(), '.ours')) {
  console.error('REFUSING: test state dir must not be the production ~/.ours');
  process.exit(1);
}

function createClient() {
  const child = spawn('node', [PLUGIN_DIST], {
    env: {
      ...process.env,
      OURS_STATE_DIR: STATE_DIR,
      OURS_BROKER_URL: BROKER_URL,
      OURS_TRANSPORT: 'stdio',
      OURS_GC_INTERVAL_MS: String(GC_MS),
    },
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
    initialize: () => send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test-gc', version: '0.0.1' } }),
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

// Status of a message in Bob's inbox: the bracketed [status], or 'unread' when no
// bracket (fmtMsg only brackets non-unread), or null when the line is gone.
async function statusOf(c, text) {
  const inbox = await c.call('list_incoming_messages');
  const line = inbox.split('\n').find((l) => l.includes(text));
  if (!line) return null;
  const m = line.match(/\[(unread|processed|ready_to_delete)\]/);
  return m ? m[1] : 'unread';
}

async function main() {
  console.log('=== ours two-generation GC e2e (interval ' + GC_MS + 'ms) ===\n');
  fs.rmSync(STATE_DIR, { recursive: true, force: true });

  const c = createClient();
  await c.initialize();

  console.log('--- setup: Alice + Bob connected ---');
  assert(/Created identity "Alice"/.test(await c.call('create_identity', { name: 'Alice' })), 'created Alice');
  const blob = inviteBlob(await c.call('generate_invite', { name: 'Bob' }));
  assert(!!blob, 'Alice generated an invite for Bob');
  assert(/Created identity "Bob"/.test(await c.call('create_identity', { name: 'Bob' })), 'created Bob');
  assert(/Added contact "Alice"/.test(await c.call('add_contact', { invite: blob })), 'Bob added Alice');
  console.log('  waiting 5s for handshake…');
  await sleep(5000);

  console.log('--- lifecycle: get_messages → processed → ready_to_delete → deleted ---');
  await c.call('choose_identity', { name: 'Alice' });
  await c.call('send_message', { contact: 'Bob', text: 'gc-life' });
  await sleep(3000);
  await c.call('choose_identity', { name: 'Bob' });
  const got = await c.call('get_messages');
  assert(/gc-life/.test(got), 'get_messages delivered gc-life (body egress)');
  // Poll the lifecycle: must pass THROUGH ready_to_delete before vanishing.
  const seen = new Set();
  let gone = false;
  for (let i = 0; i < 30; i++) {
    const st = await statusOf(c, 'gc-life');
    if (st === null) { gone = true; break; }
    seen.add(st);
    await sleep(300);
  }
  assert(!seen.has('unread'), 'gc-life never reverted to unread (it was handled)');
  assert(seen.has('ready_to_delete'), 'gc-life passed through ready_to_delete (survived ≥1 cycle — two generations)');
  assert(gone, 'gc-life was permanently deleted after a second gc tick');

  console.log('--- defer from the ready_to_delete generation (the 2nd-gen race) ---');
  await c.call('choose_identity', { name: 'Alice' });
  await c.call('send_message', { contact: 'Bob', text: 'gc-defer' });
  await sleep(3000);
  await c.call('choose_identity', { name: 'Bob' });
  const drain = await c.call('get_messages');
  assert(/gc-defer/.test(drain), 'get_messages delivered gc-defer');
  const id = parseInt(drain.match(/#(\d+)/)[1], 10);
  // Wait until it is promoted to ready_to_delete, then defer from THAT generation.
  let becameRTD = false;
  for (let i = 0; i < 30; i++) {
    const st = await statusOf(c, 'gc-defer');
    if (st === 'ready_to_delete') { becameRTD = true; break; }
    if (st === null) break;
    await sleep(250);
  }
  assert(becameRTD, 'gc-defer reached ready_to_delete');
  assert(/Deferred 1/.test(await c.call('defer_messages', { msg_ids: [id] })), 'defer_messages restored gc-defer FROM ready_to_delete');
  assert((await statusOf(c, 'gc-defer')) === 'unread', 'gc-defer is unread again');
  assert(/gc-defer/.test(await c.call('get_messages')), 'deferred gc-defer is re-delivered by get_messages');

  console.log('--- mark_processed is gone ---');
  let markResult;
  try { markResult = await c.call('mark_processed', { msg_ids: [id] }); }
  catch (e) { markResult = String(e); }
  assert(/unknown|not found|invalid|-3260\d|tool/i.test(markResult), `mark_processed tool no longer exists (got: ${markResult.slice(0, 80)})`);

  c.kill();
  await sleep(1000);
  console.log('\n=== GC TEST PASSED ===');
}

main().catch((err) => {
  console.error('\nGC TEST FAILED:', err.message);
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 500);
});
