#!/usr/bin/env node
// Tester spike for core 2.2 cluster root-side producers (asserts 1, 2, 4).
// White-box: drives the COMPILED packet's transactions directly (no TS daemon),
// so it proves the core 2.2 txs, not the in-progress daemon wiring.
//
//   ASSERT 1  MINT round-trip:    on a ROOT, sign_root_cp_binding(cp) -> {binding, cid_cp};
//             set_root_cp_binding(binding) stores it via OWN-identity verify.
//   ASSERT 2  CROSS-ROOT subst:   a ROLE pinned to RootA REJECTS a binding signed by RootB
//             (fail-closed), but ACCEPTS one signed by its OWN root (RootA).
//   ASSERT 4  CAPABILITY GATE:    live get_manifest advertises core.connect; app_id is
//             network.ours.mcp (self_supports("core.connect") would therefore be TRUE).
//
// Prereq: broker on ws://localhost:9000 (node scripts/dev-broker.mjs);
//         built unit at packages/core/dist/mufl_code (npm run build -w @ours.network/mcp,
//         or the committed packages/core/mufl_code/*.muflo — byte-identical).

import { resolve } from 'node:path';
import * as fs from 'node:fs';
import { adapt_wrapper } from '@adapt-toolkit/sdk/executables';
import { PacketWrapperConfigurator } from '@adapt-toolkit/sdk/wrappers';
import { object_to_adapt_value } from '@adapt-toolkit/sdk/wrapper';

const BROKER_URL = 'ws://localhost:9000';
const UNIT_DIR = resolve('packages/core/dist/mufl_code');
const unitHash = fs.readdirSync(UNIT_DIR).find((f) => f.endsWith('.muflo')).slice(0, -'.muflo'.length);
const UNIT_CONTENTS = new Uint8Array(fs.readFileSync(resolve(UNIT_DIR, `${unitHash}.muflo`)));

const log = (...a) => process.stderr.write(`[spike] ${a.join(' ')}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (cond, msg) => { if (!cond) throw new Error(`ASSERT FAILED: ${msg}`); console.log(`  ✓ ${msg}`); };

function makeIdentity(name) { return { name, pw: null, cid: '', pending: [] }; }

function wireHandlers(id) {
  id.pw.on_return_data = (data) => {
    const kind = data.Reduce('kind').Visualize();
    if (kind === 'save_state') return;
    if (kind === 'notify_agent') return;
    const p = id.pending.shift();
    if (!p) return;
    clearTimeout(p.timer);
    p.resolve(data.Reduce('payload'));
  };
  id.pw.on_transaction_failure = (msg) => {
    const p = id.pending.shift();
    if (p) { clearTimeout(p.timer); p.reject(new Error(msg)); }
    else { log(`${id.name} inbound rejected:`, msg); }
  };
}

function mutate(id, name, targ) {
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`${id.name}.${name} timed out`)), 20_000);
    id.pending.push({ resolve: res, reject: rej, timer });
    id.pw.add_client_message(object_to_adapt_value({ name, targ }));
  });
}
function readonly(id, name, targ) {
  return id.pw.packet.ExecuteTransaction(object_to_adapt_value({ name, targ }));
}
function bin(id, buf) { return id.pw.packet.NewBinaryFromBuffer(Buffer.from(buf)); }
function adBlob(id) { return Buffer.from(readonly(id, '::actor::export_address_document', undefined).GetBinary()); }

async function createPacket(wrapper, id, seed) {
  const config = new PacketWrapperConfigurator();
  config.process_arguments(['--unit_hash', unitHash, '--seed_phrase', seed, '--unit_dir_path', UNIT_DIR]);
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`${id.name} packet create timed out`)), 30_000);
    wrapper.packet_manager.create_packet(config, (pw) => {
      clearTimeout(t);
      id.pw = pw;
      id.cid = pw.packet.GetContainerID().Visualize();
      wireHandlers(id);
      log(`${id.name} packet created — cid ${id.cid}`);
      res();
    }, UNIT_CONTENTS);
  });
}

async function connectContacts(inviter, joiner, joinerNameOnInviter) {
  const inv = await mutate(inviter, '::a2a_messaging::generate_invite', { name: joinerNameOnInviter });
  const blob = inv.Reduce('invite').GetBinary();
  await mutate(joiner, '::a2a_messaging::add_contact', { invite: bin(joiner, blob) });
  await sleep(4000);
}

async function main() {
  log(`unit ${unitHash.slice(0, 12)}…  dir ${UNIT_DIR}`);
  const wrapper = await adapt_wrapper.start([
    '--broker_address', BROKER_URL, '--test_mode',
    '--logger_config', '--level', 'INFO', '--stdout', 'stderr', '--logger_config_end',
  ]);
  wrapper.start();
  await sleep(1500);

  const rootA = makeIdentity('RootA');
  const rootB = makeIdentity('RootB');
  const cp = makeIdentity('CP');
  const roleA = makeIdentity('RoleA');

  await createPacket(wrapper, rootA, 'spike-cp-rootA-0001');
  await createPacket(wrapper, rootB, 'spike-cp-rootB-0002');
  await createPacket(wrapper, cp, 'spike-cp-cp-0003');
  await createPacket(wrapper, roleA, 'spike-cp-roleA-0004');
  await sleep(2000);

  for (const id of [rootA, rootB, cp, roleA]) {
    await mutate(id, '::a2a_messaging::set_my_name', { name: id.name });
  }
  log('names set');

  // ---- delegate RoleA under RootA (pins RoleA's root_ad to RootA) ----
  const roleAd = adBlob(roleA);
  const signed = await mutate(rootA, '::actor::sign_delegation', { role_ad: bin(rootA, roleAd), role_id: 'RoleA' });
  const certBlob = Buffer.from(signed.Reduce('cert').GetBinary());
  const profileData = await mutate(rootA, '::actor::export_root_profile', {});
  const profileBlob = Buffer.from(profileData.Reduce('profile').GetBinary());
  await mutate(roleA, '::actor::set_delegation', {
    cert: bin(roleA, certBlob),
    root_ad: bin(roleA, adBlob(rootA)),
    root_profile: bin(roleA, profileBlob),
  });
  log('RoleA delegated under RootA');

  // ---- contacts so resolve_contact('CP') works on each root ----
  await connectContacts(rootA, cp, 'CP');
  await connectContacts(rootB, cp, 'CP');
  log('contacts established (RootA↔CP, RootB↔CP)');

  console.log('\n--- ASSERT 4: capability gate (live manifest) ---');
  const manifest = readonly(rootA, '::a2a_capabilities::get_manifest', undefined);
  const appId = manifest.Reduce('app_id').Visualize();
  assert(appId === 'network.ours.mcp', `app_id == "network.ours.mcp" (got "${appId}")`);
  const caps = manifest.Reduce('capabilities');
  const connectCap = caps.Reduce('core.connect');
  assert(!connectCap.IsNil(), 'live manifest advertises capability "core.connect" (self_supports would be TRUE)');
  assert(connectCap.Reduce('cap').Visualize() === 'core.connect', 'core.connect capability record is well-formed ($cap matches)');
  const monCap = caps.Reduce('core.monitoring');
  assert(!monCap.IsNil(), 'live manifest also advertises "core.monitoring"');

  console.log('\n--- ASSERT 1: MINT round-trip on a ROOT ---');
  const mint = await mutate(rootA, '::a2a_messaging::sign_root_cp_binding', { proxy: 'CP' });
  const mintedBlob = Buffer.from(mint.Reduce('binding').GetBinary());
  const mintedCid = mint.Reduce('cid_cp').Visualize();
  assert(mintedCid === cp.cid, `sign_root_cp_binding returned cid_cp == CP's cid (${mintedCid})`);
  assert(mintedBlob.length > 0, `sign_root_cp_binding returned a non-empty signed binding blob (${mintedBlob.length} bytes)`);
  const setRoot = await mutate(rootA, '::a2a_messaging::set_root_cp_binding', { binding: bin(rootA, mintedBlob) });
  assert(setRoot.Reduce('cid_cp').Visualize() === cp.cid, 'set_root_cp_binding on the ROOT stored it (own-identity verify passed; returned cid_cp == CP)');

  console.log('\n--- ASSERT 2: CROSS-ROOT SUBSTITUTION (security) ---');
  // RootB mints a binding for CP (signed under RootB's identity).
  const mintB = await mutate(rootB, '::a2a_messaging::sign_root_cp_binding', { proxy: 'CP' });
  const bindingB = Buffer.from(mintB.Reduce('binding').GetBinary());
  // RoleA (pinned to RootA) MUST reject RootB's binding — fail closed.
  let rejected = false;
  let abortMsg = '';
  try {
    await mutate(roleA, '::a2a_messaging::set_root_cp_binding', { binding: bin(roleA, bindingB) });
  } catch (e) {
    rejected = true;
    abortMsg = String(e).split('\n')[0];
  }
  assert(rejected, `RoleA REJECTED a binding signed by a DIFFERENT root (RootB) — fail-closed [${abortMsg}]`);
  // RoleA MUST accept a binding correctly signed by its OWN root (RootA).
  const mintA = await mutate(rootA, '::a2a_messaging::sign_root_cp_binding', { proxy: 'CP' });
  const bindingA = Buffer.from(mintA.Reduce('binding').GetBinary());
  const setRole = await mutate(roleA, '::a2a_messaging::set_root_cp_binding', { binding: bin(roleA, bindingA) });
  assert(setRole.Reduce('cid_cp').Visualize() === cp.cid, 'RoleA ACCEPTED its OWN root\'s binding (root_ad verify passed; cid_cp == CP)');

  console.log('\n=== CLUSTER-PRODUCERS SPIKE PASSED: asserts 1, 2, 4 ===');
  process.exit(0);
}

main().catch((e) => { log('SPIKE FAILED:', e.stack ?? e.message); process.exit(1); });
