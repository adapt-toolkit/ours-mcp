#!/usr/bin/env node
// Tester spike for the CID-consistency invariant (Coordinator's added local check).
// The CP keys a role on child_ad.identity.container_id (the id carried in the
// relay_enroll_delegated_node AD blob); listAgentsFor advertises role.cid
// (packet GetContainerID). The daemon comment claims both derive from one Identity
// and cannot drift. PROVE it at runtime: the container_id EMBEDDED in the role's
// exported AD == the role's packet container id.
//
// Prereq: broker on ws://localhost:9000; built unit at packages/core/dist/mufl_code.

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
    if (kind === 'save_state' || kind === 'notify_agent') return;
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
function readonly(id, name, targ) { return id.pw.packet.ExecuteTransaction(object_to_adapt_value({ name, targ })); }
function bin(id, buf) { return id.pw.packet.NewBinaryFromBuffer(Buffer.from(buf)); }
// exportAdBlob, exactly as the daemon does it (index.ts:290).
function exportAdBlob(id) { return Buffer.from(readonly(id, '::actor::export_address_document', undefined).GetBinary()); }

async function createPacket(wrapper, id, seed) {
  const config = new PacketWrapperConfigurator();
  config.process_arguments(['--unit_hash', unitHash, '--seed_phrase', seed, '--unit_dir_path', UNIT_DIR]);
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`${id.name} packet create timed out`)), 30_000);
    wrapper.packet_manager.create_packet(config, (pw) => {
      clearTimeout(t);
      id.pw = pw; id.cid = pw.packet.GetContainerID().Visualize();
      wireHandlers(id);
      log(`${id.name} packet created — cid ${id.cid}`);
      res();
    }, UNIT_CONTENTS);
  });
}

async function main() {
  log(`unit ${unitHash.slice(0, 12)}…  dir ${UNIT_DIR}`);
  const wrapper = await adapt_wrapper.start([
    '--broker_address', BROKER_URL, '--test_mode',
    '--logger_config', '--level', 'INFO', '--stdout', 'stderr', '--logger_config_end',
  ]);
  wrapper.start();
  await sleep(1500);

  const root = makeIdentity('Root');
  const role = makeIdentity('Role');
  await createPacket(wrapper, root, 'spike-cid-root-0001');
  await createPacket(wrapper, role, 'spike-cid-role-0002');
  await sleep(2000);
  await mutate(root, '::a2a_messaging::set_my_name', { name: 'Root' });
  await mutate(role, '::a2a_messaging::set_my_name', { name: 'Role' });

  // delegate Role under Root (make it a real role, as the CP enrolls)
  const roleAd = exportAdBlob(role);
  const signed = await mutate(root, '::actor::sign_delegation', { role_ad: bin(root, roleAd), role_id: 'Role' });
  const certBlob = Buffer.from(signed.Reduce('cert').GetBinary());
  const profile = await mutate(root, '::actor::export_root_profile', {});
  const profileBlob = Buffer.from(profile.Reduce('profile').GetBinary());
  await mutate(role, '::actor::set_delegation', {
    cert: bin(role, certBlob), root_ad: bin(role, exportAdBlob(root)), root_profile: bin(role, profileBlob),
  });
  log('Role delegated under Root');

  console.log('\n--- CID ROUND-TRIP INVARIANT (no-drift, CP contract) ---');
  // listAgentsFor advertises this (index.ts:701 — cid: id.cid = packet GetContainerID).
  const advertisedCid = role.pw.packet.GetContainerID().Visualize();
  // The CP keys on child_ad.identity.container_id — the id carried in the AD blob
  // the root relays (relay_enroll_delegated_node). Re-derive the AD the daemon sends…
  const childAdBlob = exportAdBlob(role);
  // …and read the embedded container_id the SAME way the core does
  // (relay: child_ad = _read_or_abort(blob) safe t_address_document; child_ad $identity $container_id).
  const childAd = role.pw.packet.ParseValue(new Uint8Array(childAdBlob));
  const embeddedCid = childAd.Reduce('identity').Reduce('container_id').Visualize();
  log(`advertised (listAgentsFor cid): ${advertisedCid}`);
  log(`embedded  (child_ad.identity.container_id): ${embeddedCid}`);
  assert(embeddedCid === advertisedCid,
    'child_ad.identity.container_id (what the CP keys on) == role.cid (what listAgentsFor advertises) — NO DRIFT');
  assert(embeddedCid === role.cid && advertisedCid === role.cid,
    'both equal the role packet\'s own GetContainerID — single source of truth');

  console.log('\n=== CID-ROUNDTRIP SPIKE PASSED: enroll id and listAgents id are byte-identical ===');
  process.exit(0);
}

main().catch((e) => { log('SPIKE FAILED:', e.stack ?? e.message); process.exit(1); });
