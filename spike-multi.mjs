#!/usr/bin/env node
// Multi-container spike: ONE adapt_wrapper hosting TWO packets (Alice + Bob),
// created lazily via create_packet_local, talking to each other through the
// broker — all in a single process. Proves the foundation for the ours_new
// multi-container redesign before the index.ts rewrite.
//
// Prereq: broker on ws://localhost:9000, built unit at packages/core/dist/mufl_code.

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

// Per-identity packet handle + FIFO of in-flight mutating resolvers.
function makeIdentity(name) {
  return { name, pw: null, cid: '', pending: [] };
}

function wireHandlers(id) {
  id.pw.on_return_data = (data) => {
    const kind = data.Reduce('kind').Visualize();
    if (kind === 'save_state') return; // ignore persistence signal in the spike
    if (kind === 'notify_agent') {
      const ev = data.Reduce('payload').Reduce('event').Visualize();
      log(`${id.name} notify:`, ev);
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

async function createPacket(wrapper, id, seed) {
  const config = new PacketWrapperConfigurator();
  config.process_arguments([
    '--unit_hash', unitHash,
    '--seed_phrase', seed,
    '--unit_dir_path', UNIT_DIR,
  ]);
  await new Promise((resolveCreate, rejectCreate) => {
    const t = setTimeout(() => rejectCreate(new Error(`${id.name} packet create timed out`)), 30_000);
    // Bypass wrapper.create_packet_local: its request_unit_local double-fires the
    // create callback for the 2nd+ packet sharing a unit. Pass contents directly.
    wrapper.packet_manager.create_packet(config, (pw) => {
      clearTimeout(t);
      id.pw = pw;
      id.cid = pw.packet.GetContainerID().Visualize();
      wireHandlers(id);
      log(`${id.name} packet created — cid ${id.cid}`);
      resolveCreate();
    }, UNIT_CONTENTS);
  });
}

async function main() {
  log(`unit ${unitHash.slice(0, 12)}…  dir ${UNIT_DIR}`);

  // Boot ONE wrapper with NO packets — just the broker connection.
  const argv = [
    '--broker_address', BROKER_URL,
    '--test_mode',
    '--logger_config', '--level', 'INFO', '--stdout', 'stderr', '--logger_config_end',
  ];
  const wrapper = await adapt_wrapper.start(argv);
  wrapper.start();
  log('wrapper started (0 packets); waiting for broker…');
  await sleep(1500);

  const alice = makeIdentity('Alice');
  const bob = makeIdentity('Bob');

  // Lazily create both packets in the same wrapper, different seeds.
  await createPacket(wrapper, alice, 'spike-alice-seed-0001');
  await createPacket(wrapper, bob, 'spike-bob-seed-0002');
  await sleep(2000); // let both register on the broker

  log(`wrapper now hosts ${wrapper.packet_manager.packets.size} packets`);
  if (wrapper.packet_manager.packets.size !== 2) throw new Error('expected 2 packets in the wrapper');

  // Names
  await mutate(alice, '::a2a_messaging::set_my_name', { name: 'Alice' });
  await mutate(bob, '::a2a_messaging::set_my_name', { name: 'Bob' });
  log('names set');

  // Alice invites Bob
  const inv = await mutate(alice, '::a2a_messaging::generate_invite', { name: 'Bob' });
  const blob = inv.Reduce('invite').GetBinary();
  log(`invite blob ${blob.length} bytes`);

  // Bob redeems the invite (binary targ built on Bob's packet)
  const blobValue = bob.pw.packet.NewBinaryFromBuffer(Buffer.from(blob));
  await mutate(bob, '::a2a_messaging::add_contact', { invite: blobValue });
  log('bob added contact; waiting for handshake + accept round trip…');
  await sleep(5000);

  // Both sides should now know each other (proves SEND A↔B routed via broker)
  const aliceContacts = readonly(alice, '::a2a_messaging::list_contacts').Visualize();
  const bobContacts = readonly(bob, '::a2a_messaging::list_contacts').Visualize();
  log('Alice contacts:', aliceContacts.replace(/\s+/g, ' '));
  log('Bob contacts:', bobContacts.replace(/\s+/g, ' '));
  if (!/Bob/.test(aliceContacts)) throw new Error('Alice did not learn Bob (accept_contact did not route)');
  if (!/Alice/.test(bobContacts)) throw new Error('Bob did not register Alice');

  // Alice → Bob message
  await mutate(alice, '::a2a_messaging::send_message', { contact: 'Bob', text: 'hello-from-alice-multi' });
  await sleep(3000);
  const bobInbox = readonly(bob, '::actor::list_incoming_messages').Visualize();
  log('Bob inbox:', bobInbox.replace(/\s+/g, ' '));
  if (!/hello-from-alice-multi/.test(bobInbox)) throw new Error('Bob did not receive the message');

  log('\n=== SPIKE PASSED: one wrapper, two packets, E2E message routed via broker ===');
  process.exit(0);
}

main().catch((e) => {
  log('SPIKE FAILED:', e.stack ?? e.message);
  process.exit(1);
});
