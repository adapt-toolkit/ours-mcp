#!/usr/bin/env node
// Identity hierarchy e2e test (see IDENTITY-HIERARCHY-DESIGN.md):
//   1. migration — a pre-existing flat identity is adopted as a role when the
//      root is created; a second root is refused,
//   2. role creation — create_identity auto-delegates under the root,
//   3. Ring 1 (intra-root) — siblings connect via delegation certs, with NO
//      contact-book entry and BYPASSING the approval queue; root <-> role too,
//   4. Ring 3 (invites) — a role invite carries the delegation cert + root
//      profile across daemons; both sides learn the verified root linkage,
//   5. restart persistence — hierarchy and verified linkage survive a restart,
//   6. set_bio on the root refreshes the profile pinned in every role.
//
// Prereq: broker on ws://localhost:9000, built bundle (cd plugin && npm run build).

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import * as fs from 'node:fs';

const PLUGIN_DIST = resolve('packages/core/dist/index.js');
const BROKER_URL = 'ws://localhost:9000';
const STATE_DIR_A = resolve(homedir(), '.ours-hier-test-a');
const STATE_DIR_B = resolve(homedir(), '.ours-hier-test-b');

function createClient(stateDir, label) {
  const child = spawn('node', [PLUGIN_DIST], {
    env: { ...process.env, OURS_STATE_DIR: stateDir, OURS_BROKER_URL: BROKER_URL, OURS_TRANSPORT: 'stdio' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '';
  const pending = new Map();
  let nextId = 1;
  child.stderr.on('data', (d) => { if (process.env.VERBOSE) process.stderr.write(`[${label}] ${d}`); });
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
    initialize: () => send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: `test-hierarchy-${label}`, version: '0.0.1' } }),
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
  console.log('=== ours identity hierarchy e2e test ===\n');
  fs.rmSync(STATE_DIR_A, { recursive: true, force: true });
  fs.rmSync(STATE_DIR_B, { recursive: true, force: true });

  let a = createClient(STATE_DIR_A, 'A');
  await a.initialize();

  // ---- Phase 1: migration + single-root invariant ----
  console.log('--- Phase 1: root creation adopts existing identities ---');
  const legacy = await a.call('create_identity', { name: 'old-bot' });
  assert(/No root identity exists/.test(legacy), 'pre-root create_identity reports the flat/legacy status');

  const rootMade = await a.call('create_root_identity', { name: 'Vitalii', bio: 'Building decentralized identity' });
  assert(/Created root identity "Vitalii"/.test(rootMade), 'root identity created');
  assert(/Adopted 1 existing identity as role\(s\): old-bot/.test(rootMade), 'existing identity adopted as a role');

  const secondRoot = await a.call('create_root_identity', { name: 'Imposter' });
  assert(/a root identity already exists \("Vitalii"\)/.test(secondRoot), 'second root is refused');

  const listed = await a.call('list_identities');
  assert(/★ Vitalii — .* \(root\)/.test(listed), 'list shows the root');
  assert(/└ old-bot — .* \(role\)/.test(listed), 'list shows the adopted role under it');

  // ---- Phase 2: new identities become roles automatically ----
  console.log('--- Phase 2: create_identity auto-delegates ---');
  const critic = await a.call('create_identity', { name: 'critic', bio: 'reviews designs harshly' });
  assert(/Delegated as a role under root "Vitalii"/.test(critic), 'new identity delegated as a role');
  const who = await a.call('current_identity');
  assert(/role "critic" under root "Vitalii"/.test(who), 'current_identity reports the hierarchy position');
  assert(/reviews designs harshly/.test(who), 'current_identity reports the bio');

  // ---- Phase 3: Ring 1 — intra-root sibling auto-accept ----
  console.log('--- Phase 3: sibling messaging (private role, approval queue bypassed) ---');
  await a.call('create_identity', { name: 'private-role', expose_local: false, local_auto_accept: false });
  await a.call('choose_identity', { name: 'critic' });
  const sib = await a.call('send_message', { contact: 'private-role', text: 'hi-from-critic-sibling' });
  assert(/intra-root sibling/.test(sib), 'send fell back to the sibling path (not the book, which has no entry)');
  await sleep(5000);

  await a.call('choose_identity', { name: 'private-role' });
  const got = await a.call('get_messages');
  assert(/hi-from-critic-sibling/.test(got), 'private role received the sibling message directly (no approval queue)');
  const pcontacts = await a.call('list_contacts');
  assert(!/Pending local introductions/.test(pcontacts), 'no pending introduction was queued (Ring 1 bypasses consent queue)');
  assert(/critic — .*\[role "critic" of Vitalii\]/.test(pcontacts), 'receiver recorded the verified sibling linkage');

  const fromRoot = await a.call('choose_identity', { name: 'Vitalii' })
    .then(() => a.call('send_message', { contact: 'private-role', text: 'hi-from-root' }));
  assert(/intra-root sibling/.test(fromRoot), 'root connects to a role via the sibling path too');
  await sleep(5000);
  await a.call('choose_identity', { name: 'private-role' });
  assert(/hi-from-root/.test(await a.call('get_messages')), 'role received the root\'s message');
  assert(/Vitalii — .*\[root identity of Vitalii\]/.test(await a.call('list_contacts')), 'role recorded the root linkage');

  // ---- Phase 4: Ring 3 — role invites carry the chain across daemons ----
  console.log('--- Phase 4: cross-daemon role invite with delegation chain ---');
  const b = createClient(STATE_DIR_B, 'B');
  await b.initialize();
  await b.call('create_root_identity', { name: 'Ivan' });
  await b.call('create_identity', { name: 'qa' });

  await a.call('choose_identity', { name: 'critic' });
  const inviteOut = await a.call('generate_invite', { name: 'qa-peer' });
  const blob = inviteOut.match(/\n\n(.+)$/s)?.[1]?.trim();
  assert(!!blob, 'critic (a role) generated an invite');

  const added = await b.call('add_contact', { invite: blob });
  assert(/Added contact "critic"/.test(added), 'qa redeemed the role invite');
  assert(/Verified delegation chain: role "critic" of Vitalii/.test(added), 'invite carried a verifiable cert + root profile');
  await sleep(6000);

  const criticContacts = await a.call('list_contacts');
  assert(/qa-peer — .*\[role "qa" of Ivan\]/.test(criticContacts), 'inviter learned the joiner\'s root linkage from the reply');

  await b.call('send_message', { contact: 'critic', text: 'cross-daemon-hello' });
  await sleep(4000);
  await a.call('choose_identity', { name: 'critic' });
  assert(/cross-daemon-hello/.test(await a.call('get_messages')), 'cross-daemon message delivered over the invite channel');

  // ---- Phase 5: restart persistence ----
  console.log('--- Phase 5: restart ---');
  a.kill();
  await sleep(2000);
  a = createClient(STATE_DIR_A, 'A2');
  await a.initialize();
  await a.call('choose_identity', { name: 'critic' });
  assert(/role "critic" under root "Vitalii"/.test(await a.call('current_identity')), 'role status survived the restart');
  assert(/qa-peer — .*\[role "qa" of Ivan\]/.test(await a.call('list_contacts')), 'verified linkage survived the restart');
  const relisted = await a.call('list_identities');
  assert(/★ Vitalii — .* \(root\)/.test(relisted) && /└ critic/.test(relisted), 'hierarchy view survived the restart');

  // ---- Phase 6: root bio refresh propagates ----
  console.log('--- Phase 6: set_bio on the root refreshes the roles ---');
  await a.call('choose_identity', { name: 'Vitalii' });
  const bioOut = await a.call('set_bio', { bio: 'Decentralized identity, now with hierarchy' });
  assert(/Root profile refreshed in 3 role\(s\)/.test(bioOut), 'root bio refresh re-pinned the profile in all 3 roles');

  a.kill();
  b.kill();
  fs.rmSync(STATE_DIR_A, { recursive: true, force: true });
  fs.rmSync(STATE_DIR_B, { recursive: true, force: true });
  console.log('\n=== ALL HIERARCHY TESTS PASSED ===');
}

main().catch((e) => {
  console.error(`\nFAILED: ${e.message}`);
  process.exit(1);
});
