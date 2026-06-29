#!/usr/bin/env node
// Upgrade + cross-version interop spike for the mufl-core migration (step 2).
//
// Phase 1 (node spike-upgrade.mjs phase1): two packets on the PRE-migration
//   unit (old-unit .muflo) establish contact and exchange a message, then both
//   export_state blobs are written to /tmp — exactly how the host persists.
// Phase 2 (node spike-upgrade.mjs phase2): Alice is recreated on the OLD unit,
//   Bob on the NEW unit, both from the same seeds + import_state of the phase-1
//   blobs. Verifies (a) a pre-migration blob restores contacts + inbox through
//   the composed core import, and (b) old->new and new->old messaging both
//   work (Option A shims + unchanged ::actor:: wire names).
//
// Prereq: broker on ws://localhost:9000; old unit at /tmp/old-unit-360F8BAF.muflo;
// new unit built at packages/core/dist/mufl_code.

import { resolve, dirname, basename } from 'node:path';
import * as fs from 'node:fs';
import { adapt_wrapper } from '@adapt-toolkit/sdk/executables';
import { PacketWrapperConfigurator } from '@adapt-toolkit/sdk/wrappers';
import { object_to_adapt_value } from '@adapt-toolkit/sdk/wrapper';

const BROKER_URL = 'ws://localhost:9000';
const OLD_UNIT_FILE = '/tmp/old-unit-360F8BAF.muflo';
const NEW_UNIT_DIR = resolve('packages/core/dist/mufl_code');
const ALICE_SEED = 'spike-upgrade-alice-0001';
const BOB_SEED = 'spike-upgrade-bob-0002';
const ALICE_BLOB = '/tmp/spike-upgrade-alice.bin';
const BOB_BLOB = '/tmp/spike-upgrade-bob.bin';

// Stage the old unit into its own unit dir named by its hash.
const OLD_UNIT_DIR = '/tmp/spike-old-unit';
fs.mkdirSync(OLD_UNIT_DIR, { recursive: true });
const oldHashFull = '360F8BAF177F13FAADD7ECBB45E784C5BFE2BE6BC792EB81639C8FD2D2D2BCC1';
fs.copyFileSync(OLD_UNIT_FILE, resolve(OLD_UNIT_DIR, `${oldHashFull}.muflo`));

const oldUnit = {
  hash: oldHashFull,
  dir: OLD_UNIT_DIR,
  contents: new Uint8Array(fs.readFileSync(OLD_UNIT_FILE)),
};
const newHash = fs.readdirSync(NEW_UNIT_DIR).find((f) => f.endsWith('.muflo')).slice(0, -'.muflo'.length);
const newUnit = {
  hash: newHash,
  dir: NEW_UNIT_DIR,
  contents: new Uint8Array(fs.readFileSync(resolve(NEW_UNIT_DIR, `${newHash}.muflo`))),
};

const log = (...a) => process.stderr.write(`[upgrade] ${a.join(' ')}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function createPacket(wrapper, id, seed, unit) {
  const config = new PacketWrapperConfigurator();
  config.process_arguments([
    '--unit_hash', unit.hash,
    '--seed_phrase', seed,
    '--unit_dir_path', unit.dir,
  ]);
  await new Promise((resolveCreate, rejectCreate) => {
    const t = setTimeout(() => rejectCreate(new Error(`${id.name} packet create timed out`)), 30_000);
    wrapper.packet_manager.create_packet(config, (pw) => {
      clearTimeout(t);
      id.pw = pw;
      id.cid = pw.packet.GetContainerID().Visualize();
      wireHandlers(id);
      log(`${id.name} packet created (unit ${unit.hash.slice(0, 8)}…) — cid ${id.cid.slice(0, 12)}…`);
      resolveCreate();
    }, unit.contents);
  });
}

async function bootWrapper() {
  const argv = [
    '--broker_address', BROKER_URL,
    '--test_mode',
    '--logger_config', '--level', 'INFO', '--stdout', 'stderr', '--logger_config_end',
  ];
  const wrapper = await adapt_wrapper.start(argv);
  wrapper.start();
  await sleep(1500);
  return wrapper;
}

function exportState(id, file) {
  const exported = readonly(id, '::actor::export_state');
  fs.writeFileSync(file, Buffer.from(exported.Serialize()));
  log(`${id.name} state exported -> ${file} (${fs.statSync(file).size} bytes)`);
}

async function importState(id, file) {
  const adaptData = id.pw.packet.ParseValue(new Uint8Array(fs.readFileSync(file)));
  await mutate(id, '::actor::import_state', adaptData);
  log(`${id.name} state imported from ${file}`);
}

async function phase1() {
  log('PHASE 1: pre-migration unit, build state + export');
  const wrapper = await bootWrapper();
  const alice = makeIdentity('Alice');
  const bob = makeIdentity('Bob');
  await createPacket(wrapper, alice, ALICE_SEED, oldUnit);
  await createPacket(wrapper, bob, BOB_SEED, oldUnit);
  await sleep(2000);

  await mutate(alice, '::actor::set_my_name', { name: 'Alice' });
  await mutate(bob, '::actor::set_my_name', { name: 'Bob' });

  const inv = await mutate(alice, '::actor::generate_invite', { name: 'Bob' });
  const blob = inv.Reduce('invite').GetBinary();
  const blobValue = bob.pw.packet.NewBinaryFromBuffer(Buffer.from(blob));
  await mutate(bob, '::actor::add_contact', { invite: blobValue });
  await sleep(5000);

  await mutate(alice, '::actor::send_message', { contact: 'Bob', text: 'pre-migration-message' });
  await sleep(3000);
  const bobInbox = readonly(bob, '::actor::list_incoming_messages').Visualize();
  if (!/pre-migration-message/.test(bobInbox)) throw new Error('phase1: Bob did not receive the message');

  exportState(alice, ALICE_BLOB);
  exportState(bob, BOB_BLOB);
  log('=== PHASE 1 DONE ===');
  process.exit(0);
}

async function phase2() {
  log('PHASE 2: old Alice + NEW Bob from imported blobs, cross-version interop');
  const wrapper = await bootWrapper();
  const alice = makeIdentity('Alice');
  const bob = makeIdentity('Bob');
  await createPacket(wrapper, alice, ALICE_SEED, oldUnit);
  await createPacket(wrapper, bob, BOB_SEED, newUnit);
  await sleep(2000);

  await importState(alice, ALICE_BLOB);
  await importState(bob, BOB_BLOB);

  // (a) pre-migration blob restored through the composed core import
  const bobContacts = readonly(bob, '::a2a_messaging::list_contacts').Visualize();
  log('new Bob contacts:', bobContacts.replace(/\s+/g, ' '));
  if (!/Alice/.test(bobContacts)) throw new Error('phase2: imported blob did not restore Alice as contact');
  let bobInbox = readonly(bob, '::actor::list_incoming_messages').Visualize();
  log('new Bob inbox:', bobInbox.replace(/\s+/g, ' '));
  if (!/pre-migration-message/.test(bobInbox)) throw new Error('phase2: imported blob did not restore the inbox');

  // (b) old -> new: old Alice sends to ::actor::receive_message — new Bob's shim
  await mutate(alice, '::actor::send_message', { contact: 'Bob', text: 'old-to-new-message' });
  await sleep(3000);
  bobInbox = readonly(bob, '::actor::list_incoming_messages').Visualize();
  if (!/old-to-new-message/.test(bobInbox)) throw new Error('phase2: old->new message did not arrive');
  log('old -> new delivered');

  // (c) new -> old: new Bob's core sends to ::actor::receive_message — old Alice has it
  await mutate(bob, '::a2a_messaging::send_message', { contact: 'Alice', text: 'new-to-old-message' });
  await sleep(3000);
  const aliceInbox = readonly(alice, '::actor::list_incoming_messages').Visualize();
  log('old Alice inbox:', aliceInbox.replace(/\s+/g, ' '));
  if (!/new-to-old-message/.test(aliceInbox)) throw new Error('phase2: new->old message did not arrive');
  log('new -> old delivered');

  log('=== PHASE 2 PASSED: pre-migration blob imports, old⇄new interop works both ways ===');
  process.exit(0);
}

const phase = process.argv[2];
const run = phase === 'phase1' ? phase1 : phase === 'phase2' ? phase2 : null;
if (!run) {
  log('usage: node spike-upgrade.mjs phase1|phase2');
  process.exit(2);
}
run().catch((e) => {
  log('SPIKE FAILED:', e.stack ?? e.message);
  process.exit(1);
});
