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
  return { dir: abs, hash: file.slice(0, -6), bytes: new Uint8Array(readFileSync(resolve(abs, file))) };
};
const units = { mcp: loadUnit(mcpUnitDir), peer: loadUnit(peerUnitDir) };

const wrapper = await adapt_wrapper.start([
  '--broker_address', brokerUrl, '--test_mode',
  '--logger_config', '--level', 'WARNING', '--stdout', 'stderr', '--logger_config_end',
]);
wrapper.start();
await sleep(1200);

const makeNode = (name) => ({ name, pw: null, cid: '', pending: [], rejects: [] });
const service = makeNode('notification-service');
const recipient = makeNode('recipient');
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
    } else node.rejects.push(String(message));
  };
}

async function createNode(node, unit, seed) {
  const config = new PacketWrapperConfigurator();
  config.process_arguments(['--unit_hash', unit.hash, '--seed_phrase', seed, '--unit_dir_path', unit.dir]);
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
const connect = async (inviter, joiner, inviterName) => {
  const result = await mutate(inviter, '::a2a_messaging::generate_invite', { name: joiner.name });
  const invite = Buffer.from(result.Reduce('invite').GetBinary());
  await mutate(joiner, '::a2a_messaging::add_contact', { invite: binary(joiner, invite), name: inviterName });
  await sleep(5000);
};

try {
  await createNode(service, units.peer, 'architect4-notify-service');
  await createNode(recipient, units.peer, 'architect4-notify-recipient');
  await createNode(mcp, units.mcp, 'architect4-notify-mcp');
  await mutate(service, '::a2a_messaging::set_my_name', { name: 'NotifyService' });
  await mutate(recipient, '::a2a_messaging::set_my_name', { name: 'Recipient' });
  await mutate(mcp, '::a2a_messaging::set_my_name', { name: 'MCP' });

  await connect(service, recipient, 'service');
  await mutate(service, '::a2a_notifications::set_vapid_public_key', { key: 'MCP_TEST_VAPID' });
  await mutate(recipient, '::a2a_notifications::notify_register', { service: 'service', bindings: null });
  await sleep(2500);

  await connect(recipient, mcp, 'recipient');
  check(readonly(recipient, '::actor::export_state').Visualize().includes('core.notifications'),
    'recipient learns cap_notifications from the MCP handshake advertisement');
  await mutate(recipient, '::a2a_notifications::notify_issue_tokens', { service: 'service', contacts: [mcp.cid] });
  await sleep(2500);
  await mutate(recipient, '::a2a_notification_integration::send_notify_address',
    { service: 'service', contact: mcp.cid });
  await sleep(2000);

  check(mcp.rejects.length === 0, 'MCP accepts the encrypted library-routed notification handout');
  const mcpExport = readonly(mcp, '::actor::export_state').Visualize();
  check(/notification_integration/.test(mcpExport) && mcpExport.includes(recipient.cid),
    'MCP composes the received handout into its exported packet state');

  const legacyAddress = Buffer.from(readonly(recipient, '::actor::qa_export_contact_notify_address',
    { service: service.cid, sender: mcp.cid }).Reduce('blob').GetBinary());
  await mutate(recipient, '::actor::qa_send_notify_address',
    { target: mcp.cid, address: binary(recipient, legacyAddress), legacy: true });
  await sleep(1500);
  check(mcp.rejects.length === 0, 'legacy ::actor::receive_notify_address shim feeds the same MCP state');

  const before = readonly(service, '::actor::qa_notify_state').Visualize();
  const sent = await mutate(mcp, '::a2a_messaging::send_message',
    { contact: recipient.cid, text: 'MCP notification integration probe' });
  const wireId = sent.Reduce('wire_id').Visualize();
  await sleep(3500);
  const after = readonly(service, '::actor::qa_notify_state').Visualize();

  check(readonly(recipient, '::actor::list_incoming_messages').Visualize().includes('MCP notification integration probe'),
    'ordinary MCP message reaches the recipient');
  check(after !== before && after.includes(wireId),
    'MCP post-send middleware wakes through the service with the actual message wire_id');
  check(after.includes(mcp.cid) && /kind.*message/.test(after),
    'MCP notification metadata carries sender and kind=message');
} finally {
  await sleep(250);
}

console.log(`notifications MUFL integration: ${failed ? `${failed} failed` : 'pass'}`);
process.exit(failed ? 1 : 0);
