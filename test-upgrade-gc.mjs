#!/usr/bin/env node
// Upgrade test for the #5 GC vocabulary bump. Complements test-upgrade.mjs (which
// covers the pre-lifecycle legacy→unread path from v0.4.1). Here the baseline is
// the LAST RELEASE BEFORE these changes, v0.5.1 (6283422), whose inbox uses the
// status field with values unread|"read". A message left in status "read" by the
// old build must migrate to "processed" on import — else it would be stuck
// forever (never returned by get_messages, never GC'd, never deferable).
//
// Phase 1 (OLD v0.5.1): leave one message "read" (get_messages drains it) and one
// "unread". Phase 2 (NEW): assert read→processed, unread stays unread, the
// migrated-processed one is not re-delivered, and it is still deferrable.
//
// Prereq: broker on ws://localhost:9000 and the NEW bundle built. The old bundle
// auto-extracts from OURS_BASELINE_REF (default 6283422 = v0.5.1) via git.

import { spawn, execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import * as fs from 'node:fs';

const NEW_DIST = resolve('packages/core/dist/index.js');
const BASELINE_REF = process.env.OURS_BASELINE_REF ?? '6283422';
const OLD_ROOT = resolve('packages/core/.upgrade-gc-old');
const OLD_DIST = resolve(OLD_ROOT, 'index.js');
const OLD_UNIT_DIR = resolve(OLD_ROOT, 'mufl_code');

function ensureOldBundle() {
  fs.mkdirSync(OLD_UNIT_DIR, { recursive: true });
  execSync(`git show ${BASELINE_REF}:packages/core/dist/index.js > ${OLD_DIST}`, { shell: '/bin/bash' });
  const muflo = execSync(`git ls-tree --name-only ${BASELINE_REF} packages/core/dist/mufl_code/`, { encoding: 'utf8' })
    .split('\n').find((p) => p.endsWith('.muflo'));
  if (!muflo) throw new Error(`no baseline .muflo at ${BASELINE_REF}`);
  execSync(`git show ${BASELINE_REF}:${muflo} > ${resolve(OLD_UNIT_DIR, muflo.split('/').pop())}`, { shell: '/bin/bash' });
}

const BROKER_URL = 'ws://localhost:9000';
const STATE_DIR = resolve(homedir(), '.ours-upgrade-gc-test');

function createClient(distPath, extraEnv = {}) {
  const child = spawn('node', [distPath], {
    env: { ...process.env, OURS_STATE_DIR: STATE_DIR, OURS_BROKER_URL: BROKER_URL, OURS_TRANSPORT: 'stdio', ...extraEnv },
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
    initialize: () => send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test-upgrade-gc', version: '0.0.1' } }),
    call: async (name, args = {}) => { const res = await send('tools/call', { name, arguments: args }); return res?.content?.[0]?.text ?? JSON.stringify(res); },
    kill: () => child.kill('SIGTERM'),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function assert(cond, msg) { if (!cond) throw new Error(`ASSERT FAILED: ${msg}`); console.log(`  ✓ ${msg}`); }
async function statusOf(c, text) {
  const inbox = await c.call('list_incoming_messages');
  const line = inbox.split('\n').find((l) => l.includes(text));
  if (!line) return null;
  const m = line.match(/\[(unread|processed|ready_to_delete|read)\]/);
  return m ? m[1] : 'unread';
}

async function main() {
  console.log('=== ours upgrade: read→processed GC migration (baseline ' + BASELINE_REF + ') ===\n');
  console.log('  extracting baseline (old v0.5.1) bundle…');
  ensureOldBundle();
  fs.rmSync(STATE_DIR, { recursive: true, force: true });

  // ---- Phase 1: OLD v0.5.1 — leave one "read" and one "unread" message ----
  console.log('--- Phase 1: OLD v0.5.1 build writes a "read" + an "unread" message ---');
  let c = createClient(OLD_DIST, { OURS_UNIT_DIR: OLD_UNIT_DIR });
  await c.initialize();
  assert(/Created identity "Alice"/.test(await c.call('create_identity', { name: 'Alice' })), 'OLD: created Alice');
  const blob = (await c.call('generate_invite', { name: 'Bob' })).match(/\n\n(.+)$/s)?.[1]?.trim();
  assert(!!blob, 'OLD: invite generated');
  await c.call('create_identity', { name: 'Bob' });
  assert(/Added contact "Alice"/.test(await c.call('add_contact', { invite: blob })), 'OLD: Bob added Alice');
  console.log('  waiting 5s for handshake…');
  await sleep(5000);

  await c.call('choose_identity', { name: 'Alice' });
  await c.call('send_message', { contact: 'Bob', text: 'will-be-read' });
  await sleep(3000);
  await c.call('choose_identity', { name: 'Bob' });
  assert(/will-be-read/.test(await c.call('get_messages')), 'OLD: Bob drained "will-be-read" (now status "read" in old schema)');

  await c.call('choose_identity', { name: 'Alice' });
  await c.call('send_message', { contact: 'Bob', text: 'stays-unread' });
  await sleep(3000);
  await c.call('choose_identity', { name: 'Bob' });
  assert((await statusOf(c, 'will-be-read')) === 'read', 'OLD: "will-be-read" persisted as status "read"');
  assert((await statusOf(c, 'stays-unread')) === 'unread', 'OLD: "stays-unread" persisted as "unread"');
  c.kill();
  await sleep(1500);
  console.log('  OLD process stopped (v0.5.1 state flushed).\n');

  // ---- Phase 2: NEW build migrates "read" -> "processed" on import ----
  console.log('--- Phase 2: upgrade to NEW build (read → processed) ---');
  c = createClient(NEW_DIST);
  await c.initialize();
  await c.call('choose_identity', { name: 'Bob' });

  assert((await statusOf(c, 'will-be-read')) === 'processed', '"will-be-read" MIGRATED "read" → "processed"');
  assert((await statusOf(c, 'stays-unread')) === 'unread', '"stays-unread" still "unread" after migration');

  const got = await c.call('get_messages');
  assert(/stays-unread/.test(got), 'get_messages delivers the still-unread message');
  assert(!/will-be-read/.test(got), 'the migrated-processed message is NOT re-delivered');

  // The migrated-processed message is still deferable (new-lifecycle tool works on it).
  const id = parseInt((await c.call('list_incoming_messages')).split('\n').find((l) => l.includes('will-be-read')).match(/#(\d+)/)[1], 10);
  assert(/Deferred 1/.test(await c.call('defer_messages', { msg_ids: [id] })), 'migrated-processed message is deferable (proves it is not stuck)');
  assert((await statusOf(c, 'will-be-read')) === 'unread', 'deferred migrated message is back to unread');

  c.kill();
  await sleep(1000);
  console.log('\n=== UPGRADE read→processed TEST PASSED ===');
}

main().catch((err) => {
  console.error('\nUPGRADE read→processed TEST FAILED:', err.message);
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 500);
});
