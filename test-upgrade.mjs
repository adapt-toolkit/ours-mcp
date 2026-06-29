#!/usr/bin/env node
// Upgrade / state-migration e2e test.
//
// Proves the WHOLE POINT of code-independent state: an identity created and
// persisted by the OLD build (pre message-lifecycle schema — inbox entries with
// no id/status, no next_msg_seq) must survive an in-place upgrade to the NEW
// build. The new import_state detects the old shape and MIGRATES it forward
// (assigns each legacy message an id + status "unread", seeds next_msg_seq),
// rather than rejecting it and resetting the identity.
//
// Phase 1 runs the OLD server bundle (auto-extracted from a pinned baseline
// commit into plugin/.upgrade-old) to write old-schema state. Phase 2 runs the
// NEW bundle against that same state dir and asserts contacts + inbox survived,
// the channel still works, and the new lifecycle tools operate on the migrated
// inbox.
//
// Prereq: broker on ws://localhost:9000 and the NEW bundle built
// (cd plugin && npm run build). The old bundle extracts itself from
// OURS_BASELINE_REF (default 5d9dc44) via git.

import { spawn, execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import * as fs from 'node:fs';

const NEW_DIST = resolve('packages/core/dist/index.js');
// Old bundle is auto-extracted from a PINNED baseline commit (the last release
// before the message-lifecycle schema change) into a scratch dir UNDER the
// plugin tree — so it resolves the externalized @adapt-toolkit/sdk from the
// repo's node_modules. Pinned (not HEAD) so it stays a valid "old" reference
// after these changes are committed.
const BASELINE_REF = process.env.OURS_BASELINE_REF ?? '5d9dc44';
const OLD_ROOT = resolve('packages/core/.upgrade-old');
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
const STATE_DIR = resolve(homedir(), '.ours-upgrade-test');

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
    child,
    initialize: () => send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test-upgrade', version: '0.0.1' } }),
    call: async (name, args = {}) => { const res = await send('tools/call', { name, arguments: args }); return res?.content?.[0]?.text ?? JSON.stringify(res); },
    kill: () => child.kill('SIGTERM'),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function assert(cond, msg) { if (!cond) throw new Error(`ASSERT FAILED: ${msg}`); console.log(`  ✓ ${msg}`); }

async function main() {
  console.log('=== ours upgrade / state-migration test ===\n');
  console.log(`  extracting baseline (old) bundle from ${BASELINE_REF}…`);
  ensureOldBundle();
  fs.rmSync(STATE_DIR, { recursive: true, force: true });

  // ---- Phase 1: OLD build writes old-schema state ----
  console.log('--- Phase 1: create + message on the OLD build ---');
  let c = createClient(OLD_DIST, { OURS_UNIT_DIR: OLD_UNIT_DIR });
  await c.initialize();
  assert(/Created identity "Alice"/.test(await c.call('create_identity', { name: 'Alice' })), 'OLD: created Alice');
  const invite = await c.call('generate_invite', { name: 'Bob' });
  const blob = invite.match(/\n\n(.+)$/s)?.[1]?.trim();
  assert(!!blob, 'OLD: Alice generated an invite');
  await c.call('create_identity', { name: 'Bob' });
  assert(/Added contact "Alice"/.test(await c.call('add_contact', { invite: blob })), 'OLD: Bob added Alice');
  console.log('  waiting 5s for handshake…');
  await sleep(5000);
  await c.call('choose_identity', { name: 'Alice' });
  await c.call('send_message', { contact: 'Bob', text: 'pre-upgrade-msg' });
  await sleep(3000);
  await c.call('choose_identity', { name: 'Bob' });
  assert(/pre-upgrade-msg/.test(await c.call('list_incoming_messages')), 'OLD: Bob received the message');
  c.kill();
  await sleep(1500); // flush old-schema state_data.bin
  console.log('  OLD process stopped (old-schema state flushed).\n');

  // Sanity: the persisted blob really is the old schema (no per-message fields).
  // (state_data.bin is binary, so just confirm the legacy host-side cursor file
  // exists — proof this state was written by the pre-lifecycle build.)
  assert(fs.existsSync(resolve(STATE_DIR, 'Bob', 'inbox_cursor')) || fs.existsSync(resolve(STATE_DIR, 'Bob', 'inbox.log')),
    'old-schema artifacts present (inbox_cursor / inbox.log)');

  // ---- Phase 2: NEW build imports + migrates ----
  console.log('--- Phase 2: upgrade to the NEW build (migrate on import) ---');
  c = createClient(NEW_DIST);
  await c.initialize();

  const ids = await c.call('list_identities');
  assert(/Alice/.test(ids) && /Bob/.test(ids), 'both identities restored after upgrade');

  await c.call('choose_identity', { name: 'Bob' });
  assert(/Alice/.test(await c.call('list_contacts')), "Bob's contact (Alice) survived the migration");
  const inbox = await c.call('list_incoming_messages');
  assert(/pre-upgrade-msg/.test(inbox), "Bob's old message survived the migration");
  assert(/#\d+/.test(inbox) && /unread/.test(inbox), 'migrated message got an id + status "unread"');

  // The migrated message is consumable through the new lifecycle.
  const got = await c.call('get_messages');
  assert(/pre-upgrade-msg/.test(got), 'get_messages delivers the migrated message');
  assert(/No new messages/.test(await c.call('get_messages')), 'migrated message not re-delivered (now read)');

  // The real proof the peer keys migrated: the channel still works post-upgrade.
  await c.call('choose_identity', { name: 'Alice' });
  await c.call('send_message', { contact: 'Bob', text: 'post-upgrade-msg' });
  await sleep(3000);
  await c.call('choose_identity', { name: 'Bob' });
  const got2 = await c.call('get_messages');
  assert(/post-upgrade-msg/.test(got2), 'new message flows after upgrade (peer keys migrated, channel intact)');

  c.kill();
  await sleep(1000);
  console.log('\n=== UPGRADE / MIGRATION TEST PASSED ===');
}

main().catch((err) => {
  console.error('\nUPGRADE TEST FAILED:', err.message);
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 500);
});
