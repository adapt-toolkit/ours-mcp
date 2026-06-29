#!/usr/bin/env node
// Upgrade-safety spike for the monitoring/control release (core 1.2 → 1.3).
//
// Phase 1 (node spike-upgrade-monitoring.mjs phase1): Alice + Bob on the
//   PRE-monitoring unit (264E6E0F…, core 1.2) establish contact, message, and
//   export_state to /tmp — exactly how the daemon persists.
// Phase 2 (… phase2): both are recreated on the NEW unit from the same seeds
//   and import the phase-1 blobs. Verifies the old blob (which has none of
//   the monitoring/control fields) imports cleanly, contacts + inbox survive,
//   monitoring defaults to disabled, and messaging still works both ways
//   (no re-handshake).
//
// Prereq: broker on ws://localhost:9000; old unit extracted to
// /tmp/old-unit-264E6E0F.muflo (git show HEAD:plugin/mufl_code/264E…muflo).

import { resolve } from 'node:path';
import * as fs from 'node:fs';
import { adapt_wrapper } from '@adapt-toolkit/sdk/executables';
import { PacketWrapperConfigurator } from '@adapt-toolkit/sdk/wrappers';
import { object_to_adapt_value } from '@adapt-toolkit/sdk/wrapper';

const BROKER_URL = 'ws://localhost:9000';
const OLD_HASH = '264E6E0FF6F2C1587AD5725F9B2E788CE792B617B6141D097F38CBB41EF3AB6A';
const OLD_UNIT_FILE = `/tmp/old-unit-264E6E0F.muflo`;
const OLD_UNIT_DIR = '/tmp/spike-old-unit-264E6E0F';
const NEW_UNIT_DIR = resolve('packages/core/dist/mufl_code');
const ALICE_SEED = 'spike-monup-alice-0001';
const BOB_SEED = 'spike-monup-bob-0002';
const ALICE_BLOB = '/tmp/spike-monup-alice.bin';
const BOB_BLOB = '/tmp/spike-monup-bob.bin';

fs.mkdirSync(OLD_UNIT_DIR, { recursive: true });
fs.copyFileSync(OLD_UNIT_FILE, resolve(OLD_UNIT_DIR, `${OLD_HASH}.muflo`));

function unitFromDir(dir) {
  const hash = fs.readdirSync(dir).find((f) => f.endsWith('.muflo')).slice(0, -'.muflo'.length);
  return { hash, dir, contents: new Uint8Array(fs.readFileSync(resolve(dir, `${hash}.muflo`))) };
}
const oldUnit = unitFromDir(OLD_UNIT_DIR);
const newUnit = unitFromDir(NEW_UNIT_DIR);

const log = (...a) => process.stderr.write(`[spike] ${a.join(' ')}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (cond, msg) => {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
};

function makeIdentity(name) {
  return { name, pw: null, cid: '', pending: [] };
}

function wireHandlers(id) {
  id.pw.on_return_data = (data) => {
    const kind = data.Reduce('kind').Visualize();
    if (kind === 'save_state') return;
    if (kind === 'notify_agent') {
      log(`${id.name} notify:`, data.Reduce('payload').Reduce('event').Visualize());
      return;
    }
    const p = id.pending.shift();
    if (!p) return;
    clearTimeout(p.timer);
    p.resolve(data.Reduce('payload'));
  };
  id.pw.on_transaction_failure = (msg) => {
    const p = id.pending.shift();
    if (p) {
      clearTimeout(p.timer);
      p.reject(new Error(msg));
    } else {
      log(`${id.name} inbound rejected:`, msg);
    }
  };
}

function mutate(id, name, targ) {
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`${id.name}.${name} timed out`)), 20_000);
    id.pending.push({ resolve: res, reject: rej, timer });
    id.pw.add_client_message(object_to_adapt_value({ name, targ }));
  });
}

function readonly(id, name) {
  return id.pw.packet.ExecuteTransaction(object_to_adapt_value({ name, targ: undefined }));
}

async function createPacket(wrapper, id, unit, seed) {
  const config = new PacketWrapperConfigurator();
  config.process_arguments(['--unit_hash', unit.hash, '--seed_phrase', seed, '--unit_dir_path', unit.dir]);
  await new Promise((resolveCreate, rejectCreate) => {
    const t = setTimeout(() => rejectCreate(new Error(`${id.name} packet create timed out`)), 30_000);
    wrapper.packet_manager.create_packet(config, (pw) => {
      clearTimeout(t);
      id.pw = pw;
      id.cid = pw.packet.GetContainerID().Visualize();
      wireHandlers(id);
      log(`${id.name} packet created (${unit.hash.slice(0, 8)}…) — cid ${id.cid}`);
      resolveCreate();
    }, unit.contents);
  });
}

async function bootWrapper() {
  const wrapper = await adapt_wrapper.start([
    '--broker_address', BROKER_URL,
    '--test_mode',
    '--logger_config', '--level', 'INFO', '--stdout', 'stderr', '--logger_config_end',
  ]);
  wrapper.start();
  await sleep(1500);
  return wrapper;
}

async function phase1() {
  const wrapper = await bootWrapper();
  const alice = makeIdentity('Alice');
  const bob = makeIdentity('Bob');
  await createPacket(wrapper, alice, oldUnit, ALICE_SEED);
  await createPacket(wrapper, bob, oldUnit, BOB_SEED);
  await sleep(2000);

  await mutate(alice, '::a2a_messaging::set_my_name', { name: 'Alice' });
  await mutate(bob, '::a2a_messaging::set_my_name', { name: 'Bob' });

  const inv = await mutate(alice, '::a2a_messaging::generate_invite', { name: 'Bob' });
  await mutate(bob, '::a2a_messaging::add_contact', {
    invite: bob.pw.packet.NewBinaryFromBuffer(Buffer.from(inv.Reduce('invite').GetBinary())),
  });
  await sleep(4000);

  await mutate(alice, '::a2a_messaging::send_message', { contact: 'Bob', text: 'pre-monitoring-message' });
  await sleep(3000);
  const bobInbox = readonly(bob, '::actor::list_incoming_messages').Visualize();
  assert(/pre-monitoring-message/.test(bobInbox), 'phase1: Bob did not receive the message');

  fs.writeFileSync(ALICE_BLOB, Buffer.from(readonly(alice, '::actor::export_state').Serialize()));
  fs.writeFileSync(BOB_BLOB, Buffer.from(readonly(bob, '::actor::export_state').Serialize()));
  log(`phase1 done — blobs at ${ALICE_BLOB}, ${BOB_BLOB}`);
  process.exit(0);
}

async function phase2() {
  const wrapper = await bootWrapper();
  const alice = makeIdentity('Alice');
  const bob = makeIdentity('Bob');
  await createPacket(wrapper, alice, newUnit, ALICE_SEED);
  await createPacket(wrapper, bob, newUnit, BOB_SEED);
  await sleep(2000);

  for (const [id, blob] of [[alice, ALICE_BLOB], [bob, BOB_BLOB]]) {
    const bytes = new Uint8Array(fs.readFileSync(blob));
    const adaptData = id.pw.packet.ParseValue(bytes);
    const res = await mutate(id, '::actor::import_state', adaptData);
    log(`${id.name} imported: contacts=${res.Reduce('contacts').Visualize()}`);
  }

  // Pre-monitoring blob → monitoring defaults in place.
  const st = readonly(alice, '::actor::get_monitoring_status');
  assert(st.Reduce('monitoring_enabled').GetBoolean() === false, 'monitoring must default to disabled after import');
  assert(st.Reduce('proxy_cid').Visualize() === '', 'no proxy must be bound after import');
  const bobInbox = readonly(bob, '::actor::list_incoming_messages').Visualize();
  assert(/pre-monitoring-message/.test(bobInbox), 'phase2: Bob lost the imported inbox');

  // Channels survive the upgrade: message both ways with no re-handshake.
  await mutate(alice, '::a2a_messaging::send_message', { contact: 'Bob', text: 'post-upgrade-a2b' });
  await sleep(2000);
  await mutate(bob, '::a2a_messaging::send_message', { contact: 'Alice', text: 'post-upgrade-b2a' });
  await sleep(4000);
  assert(/post-upgrade-a2b/.test(readonly(bob, '::actor::list_incoming_messages').Visualize()), 'A→B post-upgrade message lost');
  assert(/post-upgrade-b2a/.test(readonly(alice, '::actor::list_incoming_messages').Visualize()), 'B→A post-upgrade message lost');

  log('\n=== UPGRADE SPIKE PASSED: core-1.2 blob imports into the monitoring unit, channels intact ===');
  process.exit(0);
}

const phase = process.argv[2];
const run = phase === 'phase1' ? phase1 : phase === 'phase2' ? phase2 : null;
if (!run) {
  log('usage: node spike-upgrade-monitoring.mjs phase1|phase2');
  process.exit(2);
}
run().catch((e) => {
  log('SPIKE FAILED:', e.stack ?? e.message);
  process.exit(1);
});
