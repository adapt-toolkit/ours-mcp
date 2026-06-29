#!/usr/bin/env node
// Family-A repro: child<->CP channel establishment, against the RUNNING :3031 daemon.
//
//   Bug 1 (monitoring): monitor a child the CP has NOT contacted, have the child send a
//     message -> the child forwards an encrypted monitoring copy to the CP. The CP cannot
//     decrypt it ("Unknown source key for message decryption", key_storage.mm) because the
//     monitoring-enable flow registers the CP's AD ON the child but never registers the
//     child's AD AT the CP.
//   Bug 4 (chat): mint a child invite directly and have the CP redeem it, then the CP sends
//     the child a message -> does it deliver, or time out on the channel handshake?
//
// Prints RED/GREEN per test. Prereq: :3031 daemon + dev broker ws://localhost:9000 up.
// Pollutes :3031 with `zzz-repro-*` children (best-effort core.cluster.remove cleanup at end).

import { resolve } from 'node:path';
import * as fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { adapt_wrapper } from '@adapt-toolkit/sdk/executables';
import { PacketWrapperConfigurator } from '@adapt-toolkit/sdk/wrappers';
import { object_to_adapt_value } from '@adapt-toolkit/sdk/wrapper';

const MCP_URL = 'http://localhost:3031/mcp';
const BROKER_URL = 'ws://localhost:9000';
const ROOT = 'dev-root2';
const UNIT_DIR = resolve('packages/core/dist/mufl_code');
const unitHash = fs.readdirSync(UNIT_DIR).find((f) => f.endsWith('.muflo')).slice(0, -'.muflo'.length);
const UNIT_CONTENTS = new Uint8Array(fs.readFileSync(resolve(UNIT_DIR, `${unitHash}.muflo`)));
const RUN = String(Date.now()).slice(-7);
const CP_NAME = `LiveCP-repro-${RUN}`;
const MON = `zzz-repro-mon-${RUN}`;
const PEER = `zzz-repro-peer-${RUN}`;
const CHAT = `zzz-repro-chat-${RUN}`;

const log = (...a) => process.stderr.write(`[repro] ${a.join(' ')}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (m) => console.log(`  ✓ ${m}`);
const red = (m) => console.log(`  ✗ RED  ${m}`);
const green = (m) => console.log(`  ✓ GREEN ${m}`);
const fail = (m) => { throw new Error(`ASSERT FAILED: ${m}`); };

// ---- broker-side CP packet (SDK) ----
const inbound = []; // every inbound rejection / failure the CP packet surfaces
const inboundOk = []; // every inbound transaction the CP processed without our pending
const inboundLog = []; // Visualized payload of every inbound the CP processed (for response scanning)
function makeIdentity(name) { return { name, pw: null, cid: '', pending: [] }; }
function wireHandlers(id) {
  id.pw.on_return_data = (data) => {
    const kind = data.Reduce('kind').Visualize();
    if (kind === 'save_state') return;
    let pv = '';
    try { pv = data.Reduce('payload').Visualize(); } catch { /* opaque */ }
    if (kind === 'notify_agent') { if (pv) inboundLog.push(pv); return; }
    const p = id.pending.shift();
    if (!p) { inboundOk.push(kind); if (pv) inboundLog.push(pv); log(`${id.name} INBOUND ok:`, kind); return; }
    clearTimeout(p.timer);
    p.resolve(data.Reduce('payload'));
  };
  id.pw.on_transaction_failure = (msg) => {
    const p = id.pending.shift();
    if (p) { clearTimeout(p.timer); p.reject(new Error(msg)); }
    else { inbound.push(String(msg)); log(`${id.name} INBOUND rejected:`, String(msg).split('\n')[0]); }
  };
}
function mutate(id, name, targ, timeoutMs = 20_000) {
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`${id.name}.${name} timed out`)), timeoutMs);
    id.pending.push({ resolve: res, reject: rej, timer });
    id.pw.add_client_message(object_to_adapt_value({ name, targ }));
  });
}
function bin(id, buf) { return id.pw.packet.NewBinaryFromBuffer(Buffer.from(buf)); }
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
  const mcp = new Client({ name: 'repro-child-channel', version: '1.0.0' });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(MCP_URL)));
  const tool = async (name, args = {}) => {
    const r = await mcp.callTool({ name, arguments: args });
    const text = (r.content || []).map((c) => c.text || '').join('\n');
    if (r.isError) throw new Error(`MCP ${name} -> ${text}`);
    return text;
  };
  const cidOf = (s) => (s.match(/[0-9A-F]{64}/) || [])[0];
  log(`MCP connected ${MCP_URL}`);

  // 1) bind the daemon session to the host root
  await tool('choose_identity', { name: ROOT });
  const rootCid = cidOf(await tool('current_identity'));
  if (!rootCid) fail('could not read root cid');
  ok(`daemon session bound to ${ROOT} (root ${rootCid.slice(0, 8)})`);

  // 2) host mints an invite for the CP; CP redeems (mutual contact)
  const inviteBlob = (await tool('generate_invite', { name: CP_NAME })).trim().split(/\s+/).pop();
  const wrapper = await adapt_wrapper.start([
    '--broker_address', BROKER_URL, '--test_mode',
    '--logger_config', '--level', 'ERROR', '--stdout', 'stderr', '--logger_config_end',
  ]);
  wrapper.start();
  await sleep(1500);
  const cp = makeIdentity(CP_NAME);
  await createPacket(wrapper, cp, `repro-cp-${RUN}`);
  await sleep(1500);
  await mutate(cp, '::a2a_messaging::set_my_name', { name: CP_NAME });
  await mutate(cp, '::a2a_messaging::add_contact', { invite: bin(cp, Buffer.from(inviteBlob, 'base64url')) });
  await sleep(5000);
  ok(`CP mutual contact with ${ROOT} (CP ${cp.cid.slice(0, 8)})`);

  // 3) bind ceremony: the CP becomes the root's cluster control plane
  const code = (await tool('bind_monitoring_proxy', { contact: CP_NAME })).match(/Verification code:\s*(\d{6})/)?.[1];
  if (!code) fail('no bind code');
  await mutate(cp, '::a2a_control::send_control', {
    contact: rootCid,
    payload: JSON.stringify({ cap: 'core.monitoring', verb: 'bind', args: { code }, req_id: `repro-bind-${RUN}` }),
  });
  let bound = '';
  for (let i = 0; i < 25 && !bound; i++) { await sleep(1000); bound = (await tool('get_monitoring_status')).match(/monitoring proxy bound:\s*([0-9A-F]{64})/)?.[1] || ''; }
  if (bound !== cp.cid) fail(`root did not bind CP as cluster CP (got ${bound || 'none'})`);
  ok('CP bound as the cluster control plane (root.monitoring_proxy = CP)');

  // 4) spawn children via the REAL messenger path: core.cluster.create -> host_provision_child
  // (NOT the create_identity MCP tool, which exposes to the local book differently).
  const envCreateChild = async (name) => {
    await mutate(cp, '::a2a_control::send_control', {
      contact: rootCid,
      payload: JSON.stringify({ cap: 'core.cluster', verb: 'create', args: { name, bio: '' }, req_id: `repro-cr-${name}` }),
    });
    for (let i = 0; i < 25; i++) {
      await sleep(1000);
      try { await tool('choose_identity', { name }); const c = cidOf(await tool('current_identity')); if (c) return c; } catch { /* not yet */ }
    }
    fail(`core.cluster.create of ${name} never produced an identity`);
  };
  const monCid = await envCreateChild(MON);
  const peerCid = await envCreateChild(PEER);
  ok(`children created via core.cluster.create: ${MON} (${monCid.slice(0, 8)}), ${PEER} (${peerCid.slice(0, 8)})`);

  // ============================ BUG 1 — monitoring decrypt ============================
  console.log('\n--- Bug 1: monitor a child the CP never contacted, child sends a message ---');
  // CP enables monitoring on MON via the real envelope path
  await mutate(cp, '::a2a_control::send_control', {
    contact: rootCid,
    payload: JSON.stringify({ cap: 'core.cluster', verb: 'set_monitoring', args: { cid: monCid, enabled: true }, req_id: `repro-mon-${RUN}` }),
  });
  // confirm MON now has the CP as its monitoring proxy
  let monBound = '';
  for (let i = 0; i < 20 && !monBound; i++) {
    await sleep(1000);
    await tool('choose_identity', { name: MON });
    monBound = (await tool('get_monitoring_status')).match(/monitoring proxy bound:\s*([0-9A-F]{64})/)?.[1] || '';
  }
  if (monBound !== cp.cid) fail(`monitoring never enabled on ${MON} (proxy ${monBound || 'none'})`);
  ok(`${MON}.monitoring_proxy = CP — monitoring enabled`);

  const beforeF = inbound.length;
  const beforeOk = inboundOk.length;
  // drive MON to send PEER a message -> forces MON's monitoring copy to the CP
  await tool('choose_identity', { name: MON });
  await tool('send_message', { contact: peerCid, text: `monitored ping ${RUN}` });
  await sleep(7000); // let the forwarded copy reach the CP and (fail to) decrypt
  const newFails = inbound.slice(beforeF);
  const newOk = inboundOk.slice(beforeOk);
  log(`CP inbound since send: ${newOk.length} ok [${newOk.join(',')}], ${newFails.length} failed`);
  const srcKeyFail = newFails.find((m) => /Unknown source key/.test(m));
  if (srcKeyFail) {
    red(`CP could NOT decrypt the monitoring copy — "${srcKeyFail.split('\n')[0]}"`);
    console.log('       => Bug 1 REPRODUCED: CP lacks the monitored child\'s key.');
  } else if (newFails.length) {
    console.log(`  ?  CP surfaced a different inbound failure: ${newFails[0].split('\n')[0]}`);
  } else if (newOk.length) {
    green(`CP received + processed the monitoring copy (${newOk.join(',')}) — no decrypt failure`);
  } else {
    console.log('  ?  CP received NOTHING — the monitoring copy never arrived (copy not sent? not delivered?)');
  }

  // ============================ BUG 4 — CP -> child chat ============================
  console.log('\n--- Bug 4: CP redeems a child invite, then sends the child a message ---');
  const chatCid = await envCreateChild(CHAT);
  await tool('choose_identity', { name: CHAT });
  const chatInvite = (await tool('generate_invite', { name: CP_NAME })).trim().split(/\s+/).pop();
  await mutate(cp, '::a2a_messaging::add_contact', { invite: bin(cp, Buffer.from(chatInvite, 'base64url')) });
  await sleep(5000); // invite-reply handshake settle
  let sendErr = null;
  try {
    await mutate(cp, '::a2a_messaging::send_message', { contact: chatCid, text: `cp->child ${RUN}` }, 25_000);
  } catch (e) { sendErr = e; }
  if (sendErr) {
    red(`CP -> ${CHAT} send failed: ${sendErr.message}`);
    console.log('       => Bug 4 REPRODUCED: CP cannot message the child (half-open channel).');
  } else {
    // did the child actually receive it?
    await sleep(2000);
    await tool('choose_identity', { name: CHAT });
    const inbox = await tool('get_messages', { contact: cp.cid }).catch(() => tool('list_incoming_messages').catch(() => ''));
    if (new RegExp(`cp->child ${RUN}`).test(inbox)) green(`CP -> ${CHAT} delivered and received`);
    else console.log(`  ?  CP send returned ok but ${CHAT} inbox has no trace (delivery gap)`);
  }

  // ============== BUG 3/4 faithful — core.cluster.contact (host-minted invite) ==============
  console.log('\n--- Bug 3/4 faithful: CP contacts a child via core.cluster.contact (no choose_identity shortcut) ---');
  const CHAT2 = `zzz-repro-chat2-${RUN}`;
  const chat2Cid = await envCreateChild(CHAT2);
  const beforeLog = inboundLog.length;
  await mutate(cp, '::a2a_control::send_control', {
    contact: rootCid,
    payload: JSON.stringify({ cap: 'core.cluster', verb: 'contact', args: { cid: chat2Cid }, req_id: `repro-contact-${RUN}` }),
  });
  let contactInvite = null;
  for (let i = 0; i < 20 && !contactInvite; i++) {
    await sleep(1000);
    for (const entry of inboundLog.slice(beforeLog)) {
      const m = entry.match(/invite"?->"?([A-Za-z0-9_-]{80,})/);
      if (m) { contactInvite = m[1]; break; }
    }
  }
  if (!contactInvite) {
    red(`core.cluster.contact: CP captured no invite in inbound`);
    const cap = inboundLog.slice(beforeLog);
    console.log(`       CP captured ${cap.length} inbound payload(s) since contact:`);
    for (const e of cap) console.log(`         · ${e.slice(0, 160).replace(/\n/g, ' ')}`);
  } else {
    ok(`core.cluster.contact delivered an invite (${contactInvite.length} chars)`);
    await mutate(cp, '::a2a_messaging::add_contact', { invite: bin(cp, Buffer.from(contactInvite, 'base64url')) }, 65_000).catch((e) => log('add_contact:', e.message));
    await sleep(5000);
    let sendErr2 = null;
    try {
      await mutate(cp, '::a2a_messaging::send_message', { contact: chat2Cid, text: `cp->child(contact) ${RUN}` }, 30_000);
    } catch (e) { sendErr2 = e; }
    if (sendErr2) {
      red(`CP -> ${CHAT2} (via core.cluster.contact) send FAILED: ${sendErr2.message} — Bug 4 REPRODUCED on the real contact path`);
    } else {
      green(`CP -> ${CHAT2} (via core.cluster.contact) send OK`);
    }
  }

  // ---- best-effort cleanup ----
  console.log('\n--- cleanup ---');
  for (const c of [monCid, peerCid, chatCid, chat2Cid]) {
    await mutate(cp, '::a2a_control::send_control', {
      contact: rootCid,
      payload: JSON.stringify({ cap: 'core.cluster', verb: 'remove', args: { cid: c }, req_id: `repro-rm-${c.slice(0, 6)}` }),
    }).catch(() => {});
  }
  await sleep(2000);
  ok('cleanup fired (core.cluster.remove for the three test children)');

  await mcp.close();
  process.exit(0);
}

main().catch(async (e) => { log('REPRO ERROR:', e.stack ?? e.message); process.exit(1); });
