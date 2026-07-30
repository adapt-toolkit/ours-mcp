#!/usr/bin/env node
// Contact-name uniqueness — packet-level suite (SPEC tests 1, 2 and the
// collision half of 8), exercising the SHARED core resolver exactly where it
// lives (a2a_messaging is the same library the mcp actor loads; the daemon
// suite covers the mcp actor surface). Three nodes of the core test_actor
// fixture over a dev broker; the duplicate is injected with
// qa_force_contact_name — bypassing register_contact exactly like a
// pre-uniqueness book (no public surface can produce the state once ordinal
// suffixing is in place), while both contacts keep their live channels, so
// "send by container id still delivers" is proven by an actual delivery.
import { resolve } from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import { adapt_wrapper } from '@adapt-toolkit/sdk/executables';
import { PacketWrapperConfigurator } from '@adapt-toolkit/sdk/wrappers';
import { object_to_adapt_value } from '@adapt-toolkit/sdk/wrapper';

const brokerUrl = process.env.BROKER_URL;
const peerUnitDir = process.env.PEER_UNIT_DIR;
if (!brokerUrl || !peerUnitDir) {
  throw new Error('BROKER_URL and PEER_UNIT_DIR are required');
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const loadUnit = (dir) => {
  const abs = resolve(dir);
  const file = readdirSync(abs).find((name) => name.endsWith('.muflo'));
  if (!file) throw new Error(`no .muflo found in ${abs}`);
  return {
    dir: abs,
    hash: file.slice(0, -'.muflo'.length),
    bytes: new Uint8Array(readFileSync(resolve(abs, file))),
  };
};

const units = { peer: loadUnit(peerUnitDir) };
const wrapper = await adapt_wrapper.start([
  '--broker_address', brokerUrl,
  '--test_mode',
  '--logger_config', '--level', 'WARNING', '--stdout', 'stderr', '--logger_config_end',
]);
wrapper.start();
await sleep(1200);

const makeNode = (name) => ({ name, pw: null, cid: '', pending: [], rejects: [] });
const p = makeNode('book-holder');
const x = makeNode('peer-x');
const y = makeNode('peer-y');

function wire(node) {
  node.pw.on_return_data = (data) => {
    const kind = data.Reduce('kind').Visualize();
    if (kind === 'notify_agent' || kind === 'save_state') return;
    const pending = node.pending.shift();
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.resolve(data.Reduce('payload'));
  };
  node.pw.on_transaction_failure = (message) => {
    const pending = node.pending.shift();
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    } else {
      node.rejects.push(String(message));
    }
  };
}

async function createNode(node, unit, seed) {
  const config = new PacketWrapperConfigurator();
  config.process_arguments([
    '--unit_hash', unit.hash,
    '--seed_phrase', seed,
    '--unit_dir_path', unit.dir,
  ]);
  await new Promise((resolveCreate, rejectCreate) => {
    const timer = setTimeout(() => rejectCreate(new Error(`${node.name} create timed out`)), 30_000);
    wrapper.packet_manager.create_packet(config, (pw) => {
      clearTimeout(timer);
      node.pw = pw;
      node.cid = pw.packet.GetContainerID().Visualize();
      wire(node);
      resolveCreate();
    }, unit.bytes);
  });
}

function mutate(node, name, targ = {}) {
  return new Promise((resolveMutation, rejectMutation) => {
    const timer = setTimeout(() => rejectMutation(new Error(`${node.name}.${name} timed out`)), 20_000);
    node.pending.push({ resolve: resolveMutation, reject: rejectMutation, timer });
    node.pw.add_client_message(object_to_adapt_value({ name, targ }));
  });
}
const failureOf = async (node, name, targ = {}) => {
  try {
    await mutate(node, name, targ);
    return null;
  } catch (err) {
    return String(err.message ?? err);
  }
};

const readonly = (node, name, targ = {}) =>
  node.pw.packet.ExecuteTransaction(object_to_adapt_value({ name, targ }));
const binary = (node, bytes) => node.pw.packet.NewBinaryFromBuffer(Buffer.from(bytes));
// Poll the recipient's inbox for a marker instead of guessing a fixed delay.
async function delivered(node, marker, ms = 15_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const inbox = readonly(node, '::actor::list_incoming_messages').Visualize();
    if (inbox.includes(marker)) return true;
    if (Date.now() > deadline) { console.error(`    [inbox of ${node.name}]: ${inbox}`); return false; }
    await sleep(500);
  }
}

let failed = 0;
const check = (condition, message) => {
  if (condition) console.log(`  ✓ ${message}`);
  else { failed += 1; console.error(`  ✗ ${message}`); }
};

try {
  await createNode(p, units.peer, 'uniq-book-holder');
  await createNode(x, units.peer, 'uniq-peer-x');
  await createNode(y, units.peer, 'uniq-peer-y');
  await mutate(p, '::a2a_messaging::set_my_name', { name: 'P' });
  await mutate(x, '::a2a_messaging::set_my_name', { name: 'PeerX' });
  await mutate(y, '::a2a_messaging::set_my_name', { name: 'PeerY' });

  // Real invite handshakes: P registers X as "X" and Y as "Y".
  const invX = await mutate(p, '::a2a_messaging::generate_invite', { name: 'X' });
  await mutate(x, '::a2a_messaging::add_contact', {
    invite: binary(x, Buffer.from(invX.Reduce('invite').GetBinary())), name: 'P',
  });
  await sleep(4000);
  const invY = await mutate(p, '::a2a_messaging::generate_invite', { name: 'Y' });
  await mutate(y, '::a2a_messaging::add_contact', {
    invite: binary(y, Buffer.from(invY.Reduce('invite').GetBinary())), name: 'P',
  });
  await sleep(4000);
  const book0 = readonly(p, '::a2a_messaging::list_contacts').Visualize();
  check(book0.includes(x.cid) && book0.includes(y.cid), 'setup: P holds X and Y via real invite handshakes');

  // Inject the duplicate: Y's entry takes X's name (pre-uniqueness book state).
  await mutate(p, '::actor::qa_force_contact_name', { cid: y.cid, name: 'X' });

  // SPEC test 1 — send by the shared name ABORTS naming both candidates …
  const ambSend = await failureOf(p, '::a2a_messaging::send_message', { contact: 'X', text: 'coin-flip probe' });
  check(ambSend !== null, 'SPEC1: send_message by a name matching two contacts aborts');
  check(ambSend !== null && /is ambiguous/.test(ambSend), 'SPEC1: the abort says the name is ambiguous');
  check(ambSend !== null && ambSend.includes(x.cid) && ambSend.includes(y.cid), 'SPEC1: the abort lists BOTH candidate container ids');
  check(ambSend !== null && !/Unknown contact/.test(ambSend), 'SPEC1: the ambiguity error does NOT contain "Unknown contact" (auto-connect guard)');

  // … and by container id it succeeds, to the INTENDED one (real delivery).
  await mutate(p, '::a2a_messaging::send_message', { contact: x.cid, text: 'cid-addressed probe' });
  check(await delivered(x, 'cid-addressed probe'), 'SPEC1: send by container id DELIVERED to the intended contact');

  // SPEC test 2 — remove_contact by the shared name aborts (no coin-flip delete).
  const ambRemove = await failureOf(p, '::a2a_messaging::remove_contact', { contact: 'X' });
  check(ambRemove !== null && /is ambiguous/.test(ambRemove), 'SPEC2: remove_contact by the shared name aborts');
  const book1 = readonly(p, '::a2a_messaging::list_contacts').Visualize();
  check(book1.includes(x.cid) && book1.includes(y.cid), 'SPEC2: both contacts still present after the aborted remove');

  // SPEC test 8 (collision half) — rename by container id repairs the book …
  await mutate(p, '::a2a_messaging::rename_contact', { contact: y.cid, name: 'Y-again' });
  const renSend = await failureOf(p, '::a2a_messaging::send_message', { contact: 'X', text: 'post-repair probe' });
  check(renSend === null, 'SPEC8: after rename_contact by cid, send by the now-unique name succeeds');
  check(await delivered(x, 'post-repair probe'), 'SPEC8: the post-repair message DELIVERED to the intended contact');

  // … and renaming ONTO a taken name is refused.
  const renClash = await failureOf(p, '::a2a_messaging::rename_contact', { contact: y.cid, name: 'X' });
  check(renClash !== null && /already held by contact/.test(renClash) && renClash.includes(x.cid),
    'SPEC8: renaming to a taken name is refused, naming the holder');

  check(p.rejects.length === 0 && x.rejects.length === 0 && y.rejects.length === 0,
    'no unexpected inbound transaction failures anywhere');
} finally {
  await sleep(250);
}

console.log(`contact-uniqueness MUFL integration: ${failed ? `${failed} failed` : 'pass'}`);
process.exit(failed ? 1 : 0);
