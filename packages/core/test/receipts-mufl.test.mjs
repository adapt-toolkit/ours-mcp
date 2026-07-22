#!/usr/bin/env node
import { resolve } from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import { adapt_wrapper } from '@adapt-toolkit/sdk/executables';
import { PacketWrapperConfigurator } from '@adapt-toolkit/sdk/wrappers';
import { object_to_adapt_value } from '@adapt-toolkit/sdk/wrapper';

const brokerUrl = process.env.BROKER_URL;
const mcpUnitDir = process.env.MCP_UNIT_DIR;
const peerUnitDir = process.env.PEER_UNIT_DIR;
if (!brokerUrl || !mcpUnitDir || !peerUnitDir) {
  throw new Error('BROKER_URL, MCP_UNIT_DIR, and PEER_UNIT_DIR are required');
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

const units = { mcp: loadUnit(mcpUnitDir), peer: loadUnit(peerUnitDir) };
const wrapper = await adapt_wrapper.start([
  '--broker_address', brokerUrl,
  '--test_mode',
  '--logger_config', '--level', 'WARNING', '--stdout', 'stderr', '--logger_config_end',
]);
wrapper.start();
await sleep(1200);

const makeNode = (name) => ({ name, pw: null, cid: '', pending: [], rejects: [] });
const peer = makeNode('receipt-peer');
const mcp = makeNode('mcp');

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

const readonly = (node, name, targ = {}) =>
  node.pw.packet.ExecuteTransaction(object_to_adapt_value({ name, targ }));
const binary = (node, bytes) => node.pw.packet.NewBinaryFromBuffer(Buffer.from(bytes));

let failed = 0;
const check = (condition, message) => {
  if (condition) console.log(`  ✓ ${message}`);
  else { failed += 1; console.error(`  ✗ ${message}`); }
};

try {
  await createNode(peer, units.peer, 'architect4-receipt-peer');
  await createNode(mcp, units.mcp, 'architect4-mcp');
  await mutate(peer, '::a2a_messaging::set_my_name', { name: 'ReceiptPeer' });
  await mutate(mcp, '::a2a_messaging::set_my_name', { name: 'MCP' });

  // The peer promises it can receive receipt transactions before the invite,
  // so MCP learns that positive capability through the real handshake.
  await mutate(peer, '::actor::qa_init_caps', { advertise: ['core.receipts.receive'] });
  const inviteResult = await mutate(peer, '::a2a_messaging::generate_invite', { name: 'MCP' });
  const invite = Buffer.from(inviteResult.Reduce('invite').GetBinary());
  await mutate(mcp, '::a2a_messaging::add_contact', { invite: binary(mcp, invite), name: 'ReceiptPeer' });
  await sleep(5000);

  check(readonly(peer, '::a2a_messaging::list_contacts').Visualize().includes(mcp.cid),
    'real invite handshake established the MCP contact');
  check(readonly(mcp, '::a2a_messaging::list_contacts').Visualize().includes(peer.cid),
    'real invite handshake established the receipt peer');

  const wireId = 'architect4-receipt-wire';
  await mutate(peer, '::actor::qa_send_stamped_message', {
    target: mcp.cid,
    text: 'receipt integration probe',
    pv: 7,
    wire_id: wireId,
  });
  await sleep(5000);

  const mcpInboxBeforeRead = readonly(mcp, '::actor::list_incoming_messages').Visualize();

  let receiptLog = readonly(peer, '::actor::qa_receipts_log').Visualize();
  check(receiptLog.includes(wireId) && /delivered/.test(receiptLog),
    'MCP emits a delivered receipt for the accepted message');

  check(mcpInboxBeforeRead.includes('receipt integration probe'),
    'MCP inbox contains the delivered probe before it is read');
  await mutate(mcp, '::actor::get_messages');
  check(readonly(mcp, '::actor::list_incoming_messages').Visualize().includes('processed'),
    'MCP get_messages transitions the probe out of unread');
  await sleep(2500);

  receiptLog = readonly(peer, '::actor::qa_receipts_log').Visualize();
  check(receiptLog.includes(wireId) && /read/.test(receiptLog),
    'MCP emits a read receipt when get_messages marks the message processed');
  check(peer.rejects.length === 0 && mcp.rejects.length === 0,
    'receipt traffic causes no inbound transaction failures');
} finally {
  await sleep(250);
}

console.log(`receipts MUFL integration: ${failed ? `${failed} failed` : 'pass'}`);
process.exit(failed ? 1 : 0);
