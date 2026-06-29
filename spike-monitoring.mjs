#!/usr/bin/env node
// Monitoring + control-plane spike (see MONITORING-AND-SHARED-LIBRARY-DESIGN.md):
// ONE wrapper, FOUR packets on the agent unit — Root, Dev (a delegated role),
// Peer (an external contact of Dev), Proxy (the browser/messenger account) —
// exercising the full MUFL layer end to end over the broker:
//
//   1. hierarchy: Root delegates Dev; Dev connect_sibling's to Root
//   2. pre-enable: Dev↔Peer traffic produces NO monitoring copies
//   3. enable: sign_monitoring_auth (Root) → set_monitoring (Dev)
//   4. Dev→Peer and Peer→Dev messages both land as copies in Root's
//      monitoring inbox (direction out / in, correct bodies)
//   5. proxy binding: wrong code burns an attempt, right code binds, and the
//      pending state survives the wrong attempt atomically
//   6. control round trip: Proxy → ::a2a_control::send_control → Root's
//      control_inbox (NOT its message inbox) → response back to Proxy
//
// The daemon's TS dispatcher (plugin/src/index.ts) is simulated inline where
// it would act (steps 5-6), exactly as it does in production.
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

function makeIdentity(name) {
  return { name, pw: null, cid: '', pending: [] };
}

function wireHandlers(id) {
  id.pw.on_return_data = (data) => {
    const kind = data.Reduce('kind').Visualize();
    if (kind === 'save_state') return;
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

function readonly(id, name, targ) {
  return id.pw.packet.ExecuteTransaction(object_to_adapt_value({ name, targ }));
}

function bin(id, buf) {
  return id.pw.packet.NewBinaryFromBuffer(Buffer.from(buf));
}

function adBlob(id) {
  return Buffer.from(readonly(id, '::actor::export_address_document', undefined).GetBinary());
}

function renderList(v, fields) {
  const out = [];
  if (v.IsNil()) return out;
  for (let i = 0; ; i++) {
    const m = v.Reduce(i);
    if (m.IsNil()) break;
    const row = {};
    for (const f of fields) row[f] = m.Reduce(f).Visualize();
    out.push(row);
  }
  return out;
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

const assert = (cond, msg) => {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
};

async function connectContacts(inviter, joiner, joinerNameOnInviter) {
  const inv = await mutate(inviter, '::a2a_messaging::generate_invite', { name: joinerNameOnInviter });
  const blob = inv.Reduce('invite').GetBinary();
  await mutate(joiner, '::a2a_messaging::add_contact', { invite: bin(joiner, blob) });
  await sleep(4000);
}

async function main() {
  log(`unit ${unitHash.slice(0, 12)}…  dir ${UNIT_DIR}`);

  const wrapper = await adapt_wrapper.start([
    '--broker_address', BROKER_URL,
    '--test_mode',
    '--logger_config', '--level', 'INFO', '--stdout', 'stderr', '--logger_config_end',
  ]);
  wrapper.start();
  await sleep(1500);

  const root = makeIdentity('Root');
  const dev = makeIdentity('Dev');
  const peer = makeIdentity('Peer');
  const proxy = makeIdentity('Proxy');

  await createPacket(wrapper, root, 'spike-mon-root-0001');
  await createPacket(wrapper, dev, 'spike-mon-dev-0002');
  await createPacket(wrapper, peer, 'spike-mon-peer-0003');
  await createPacket(wrapper, proxy, 'spike-mon-proxy-0004');
  await sleep(2000);

  for (const id of [root, dev, peer, proxy]) {
    await mutate(id, '::a2a_messaging::set_my_name', { name: id.name });
  }
  log('names set');

  // ---- 1. hierarchy: Root delegates Dev --------------------------------------
  const devAd = adBlob(dev);
  const signed = await mutate(root, '::actor::sign_delegation', {
    role_ad: bin(root, devAd),
    role_id: 'Dev',
  });
  const certBlob = Buffer.from(signed.Reduce('cert').GetBinary());
  const profileData = await mutate(root, '::actor::export_root_profile', {});
  const profileBlob = Buffer.from(profileData.Reduce('profile').GetBinary());
  await mutate(dev, '::actor::set_delegation', {
    cert: bin(dev, certBlob),
    root_ad: bin(dev, adBlob(root)),
    root_profile: bin(dev, profileBlob),
  });
  log('Dev delegated under Root');

  // Dev ↔ Root channel + the contact_roots linkage receive_monitoring_copy checks.
  await mutate(dev, '::actor::connect_sibling', {
    name: 'Root',
    target_ad: bin(dev, adBlob(root)),
  });
  await sleep(4000);
  log('Dev connected to Root as a sibling');

  // ---- contacts: Dev↔Peer, Proxy↔Root ----------------------------------------
  await connectContacts(dev, peer, 'Peer');
  await connectContacts(root, proxy, 'Proxy');
  log('contacts established (Dev↔Peer, Root↔Proxy)');

  // ---- 2. monitoring disabled → no copies ------------------------------------
  await mutate(dev, '::a2a_messaging::send_message', { contact: 'Peer', text: 'pre-enable-msg' });
  await sleep(3000);
  let copies = renderList(
    (await mutate(root, '::actor::get_monitoring_copies', {})).Reduce('copies'),
    ['direction', 'body'],
  );
  assert(copies.length === 0, `expected 0 copies before enable, got ${copies.length}`);
  log('pre-enable: no copies (correct)');

  // ---- 3. enable monitoring ---------------------------------------------------
  let st = readonly(dev, '::actor::get_monitoring_status', undefined);
  assert(st.Reduce('monitoring_enabled').GetBoolean() === false, 'Dev monitoring should start disabled');
  const auth = await mutate(root, '::actor::sign_monitoring_auth', {
    role_ad: bin(root, devAd),
    enabled: true,
  });
  await mutate(dev, '::actor::set_monitoring', {
    auth: bin(dev, Buffer.from(auth.Reduce('auth').GetBinary())),
  });
  st = readonly(dev, '::actor::get_monitoring_status', undefined);
  assert(st.Reduce('monitoring_enabled').GetBoolean() === true, 'Dev monitoring should be enabled');
  log('monitoring enabled on Dev (root-signed auth verified)');

  // A peer's auth must NOT work: Peer signs an auth for Dev → set_monitoring aborts.
  const forged = await mutate(peer, '::actor::sign_monitoring_auth', {
    role_ad: bin(peer, devAd),
    enabled: false,
  });
  let forgeRejected = false;
  try {
    await mutate(dev, '::actor::set_monitoring', {
      auth: bin(dev, Buffer.from(forged.Reduce('auth').GetBinary())),
    });
  } catch (e) {
    // Either the explicit abort or key_storage's own "Key not found for the
    // signature provided" (the forger's key is not in the root's key list).
    log('forged auth rejected with:', String(e).split('\n')[0]);
    forgeRejected = true;
  }
  assert(forgeRejected, 'a non-root-signed monitoring auth must be rejected');
  st = readonly(dev, '::actor::get_monitoring_status', undefined);
  assert(st.Reduce('monitoring_enabled').GetBoolean() === true, 'forged auth must not change the flag');
  log('forged monitoring auth rejected (correct)');

  // ---- 4. copies flow to the root ---------------------------------------------
  await mutate(dev, '::a2a_messaging::send_message', { contact: 'Peer', text: 'monitored-out-1' });
  await sleep(2000);
  await mutate(peer, '::a2a_messaging::send_message', { contact: 'Dev', text: 'monitored-in-1' });
  await sleep(4000);

  copies = renderList(
    (await mutate(root, '::actor::get_monitoring_copies', {})).Reduce('copies'),
    ['direction', 'body', 'source_name', 'peer_name'],
  );
  log('copies:', JSON.stringify(copies));
  assert(copies.length === 2, `expected 2 copies, got ${copies.length}`);
  const outCopy = copies.find((c) => c.direction === 'out');
  const inCopy = copies.find((c) => c.direction === 'in');
  assert(outCopy && outCopy.body === 'monitored-out-1' && outCopy.source_name === 'Dev' && outCopy.peer_name === 'Peer', 'outbound copy wrong');
  assert(inCopy && inCopy.body === 'monitored-in-1' && inCopy.peer_name === 'Peer', 'inbound copy wrong');
  // Drained on read:
  const drained = renderList((await mutate(root, '::actor::get_monitoring_copies', {})).Reduce('copies'), ['body']);
  assert(drained.length === 0, 'monitoring inbox must clear on read');
  log('monitoring copies delivered to Root, both directions, drained on read');

  // ---- 5. proxy binding (simulating the daemon dispatcher) ---------------------
  await mutate(root, '::actor::set_proxy_pending', { code: '123456', proxy: 'Proxy' });

  // Proxy sends a WRONG bind over the real control channel.
  await mutate(proxy, '::a2a_control::send_control', {
    contact: 'Root',
    payload: JSON.stringify({ v: 1, t: 'bind', code: '000000', id: 'req-1' }),
  });
  await sleep(4000);
  let reqs = renderList(
    (await mutate(root, '::actor::get_control_requests', {})).Reduce('requests'),
    ['sender_cid', 'sender_name', 'payload'],
  );
  assert(reqs.length === 1, `expected 1 control request, got ${reqs.length}`);
  assert(reqs[0].sender_name === 'Proxy', 'control request sender mismatch');
  const wrongMsg = JSON.parse(reqs[0].payload);
  let verdict = await mutate(root, '::actor::verify_proxy_code', {
    code: String(wrongMsg.code),
    sender: reqs[0].sender_cid,
  });
  assert(verdict.Reduce('verified').GetBoolean() === false, 'wrong code must not verify');
  assert(verdict.Reduce('reason').Visualize() === 'wrong_code', 'reason should be wrong_code');
  log('wrong bind code rejected, attempt burned');

  // Root's MESSAGE inbox must not contain control traffic.
  const rootInbox = readonly(root, '::actor::list_incoming_messages', undefined).Visualize();
  assert(!/bind/.test(rootInbox), 'control requests must not leak into the message inbox');

  // Right code → bound.
  await mutate(proxy, '::a2a_control::send_control', {
    contact: 'Root',
    payload: JSON.stringify({ v: 1, t: 'bind', code: '123456', id: 'req-2' }),
  });
  await sleep(4000);
  reqs = renderList(
    (await mutate(root, '::actor::get_control_requests', {})).Reduce('requests'),
    ['sender_cid', 'payload'],
  );
  assert(reqs.length === 1, `expected 1 control request, got ${reqs.length}`);
  const rightMsg = JSON.parse(reqs[0].payload);
  verdict = await mutate(root, '::actor::verify_proxy_code', {
    code: String(rightMsg.code),
    sender: reqs[0].sender_cid,
  });
  assert(verdict.Reduce('verified').GetBoolean() === true, 'right code must verify');
  st = readonly(root, '::actor::get_monitoring_status', undefined);
  assert(st.Reduce('proxy_cid').Visualize() === proxy.cid, 'monitoring_proxy must be the Proxy cid');
  log('proxy bound with the right code');

  // ---- 6. response path: Root → Proxy control event ---------------------------
  await mutate(root, '::a2a_control::send_control', {
    contact: 'Proxy',
    payload: JSON.stringify({ v: 1, t: 'res', id: 'req-2', ok: true }),
  });
  await sleep(4000);
  const proxyReqs = renderList(
    (await mutate(proxy, '::actor::get_control_requests', {})).Reduce('requests'),
    ['sender_name', 'payload'],
  );
  assert(proxyReqs.length === 1, `expected 1 control event at the proxy, got ${proxyReqs.length}`);
  const res = JSON.parse(proxyReqs[0].payload);
  assert(res.t === 'res' && res.ok === true && res.id === 'req-2', 'response payload mismatch');
  log('control response delivered to the proxy');

  // ---- 7-10. CLUSTER-CHILD VISIBILITY (repro for the OOB-child bug) -----------
  // Daemon-faithful simulation: the TS daemon's listAgentsFor(root) enumerates the
  // roles delegated under the root (index.ts:689-709). create_agent (CP-initiated)
  // enrolls + replies with fresh agents; create_identity (out-of-band MCP/CLI) only
  // delegateRole's — NO push to the bound proxy. So a child created out-of-band is
  // absent from the CP's view until the CP itself re-issues list_agents.
  //
  // `roles` mirrors the daemon's identities-under-root set. Dev was delegated in
  // step 1; a list_agents control verb returns exactly these.
  const roles = [dev];

  // Stand in for the daemon's handleControlRequest('list_agents'): drain the root's
  // control inbox, build agents from the current role set, send a `res` to the proxy.
  // This is the ONLY way the CP learns the agent list — there is no push path.
  async function daemonAnswerListAgents(reqId) {
    const inbound = renderList(
      (await mutate(root, '::actor::get_control_requests', {})).Reduce('requests'),
      ['sender_cid', 'sender_name', 'payload'],
    );
    const got = inbound.find((r) => { try { return JSON.parse(r.payload).t === 'list_agents'; } catch { return false; } });
    assert(got, 'root should have received the list_agents control request');
    const agents = roles.map((r) => ({ name: r.name, cid: r.cid }));
    await mutate(root, '::a2a_control::send_control', {
      contact: 'Proxy',
      payload: JSON.stringify({ v: 1, t: 'res', id: reqId, req: 'list_agents', ok: true, agents }),
    });
  }

  // Read the agents[] the proxy received from its control inbox (drains on read,
  // exactly like the messenger's `res`-handler resolving a pending request).
  async function proxyReadAgents(expectId) {
    const events = renderList(
      (await mutate(proxy, '::actor::get_control_requests', {})).Reduce('requests'),
      ['sender_name', 'payload'],
    );
    const res = events.map((e) => { try { return JSON.parse(e.payload); } catch { return null; } })
      .find((m) => m && m.t === 'res' && m.id === expectId);
    return res ? res.agents : null; // null = the CP got NO list_agents push (stale)
  }

  // (7) BASELINE: proxy issues list_agents → Dev present.
  console.log('\n--- STEP 7: list_agents baseline (Dev must be present) ---');
  await mutate(proxy, '::a2a_control::send_control', {
    contact: 'Root',
    payload: JSON.stringify({ v: 1, t: 'list_agents', id: 'la-1' }),
  });
  await sleep(4000);
  await daemonAnswerListAgents('la-1');
  await sleep(4000);
  let agents = await proxyReadAgents('la-1');
  assert(agents && agents.length === 1, `baseline list_agents should return 1 agent, got ${agents ? agents.length : 'none'}`);
  assert(agents[0].name === 'Dev', `baseline agent should be Dev, got ${agents[0].name}`);
  log('baseline: CP sees Dev (1 agent)');

  // (8) OUT-OF-BAND CHILD: delegate Dev2 under Root via the create_identity path
  //     (sign_delegation + set_delegation) — NOT create_agent, so NO CP enroll/push.
  console.log('\n--- STEP 8: create a child out-of-band (create_identity path, no CP push) ---');
  const dev2 = makeIdentity('Dev2');
  await createPacket(wrapper, dev2, 'spike-mon-dev2-0005');
  await sleep(1500);
  await mutate(dev2, '::a2a_messaging::set_my_name', { name: 'Dev2' });
  const dev2Ad = adBlob(dev2);
  const signed2 = await mutate(root, '::actor::sign_delegation', { role_ad: bin(root, dev2Ad), role_id: 'Dev2' });
  const cert2 = Buffer.from(signed2.Reduce('cert').GetBinary());
  const prof2 = await mutate(root, '::actor::export_root_profile', {});
  const profBlob2 = Buffer.from(prof2.Reduce('profile').GetBinary());
  await mutate(dev2, '::actor::set_delegation', {
    cert: bin(dev2, cert2),
    root_ad: bin(dev2, adBlob(root)),
    root_profile: bin(dev2, profBlob2),
  });
  roles.push(dev2); // now a real role under Root — listAgentsFor WOULD include it
  log('Dev2 delegated under Root out-of-band (no enrollRoleToCp, no list_agents push)');

  // (9) STALE: the proxy received NO push about Dev2 — its control inbox is empty.
  console.log('\n--- STEP 9: assert the CP got NO push (bug: child is invisible) ---');
  await sleep(4000);
  const pushAfter = await proxyReadAgents('la-1');
  assert(pushAfter === null, `out-of-band creation must NOT push agents to the CP, but a push arrived: ${JSON.stringify(pushAfter)}`);
  log('confirmed: no control push reached the CP after out-of-band creation (stale view) — BUG REPRODUCED');

  // (10) REFRESH BACKSTOP: proxy re-issues list_agents → Dev2 now appears.
  console.log('\n--- STEP 10: manual refresh (list_agents) surfaces Dev2 — validates refreshAgents-on-open ---');
  await mutate(proxy, '::a2a_control::send_control', {
    contact: 'Root',
    payload: JSON.stringify({ v: 1, t: 'list_agents', id: 'la-2' }),
  });
  await sleep(4000);
  await daemonAnswerListAgents('la-2');
  await sleep(4000);
  agents = await proxyReadAgents('la-2');
  assert(agents && agents.length === 2, `after refresh list_agents should return 2 agents, got ${agents ? agents.length : 'none'}`);
  const names = agents.map((a) => a.name).sort();
  assert(names[0] === 'Dev' && names[1] === 'Dev2', `refresh should show Dev + Dev2, got ${JSON.stringify(names)}`);
  log('refresh surfaces Dev2 — pull-only confirmed; refreshAgents-on-openNode is the correct UI backstop');

  log('\n=== MONITORING SPIKE PASSED: hierarchy, copies both directions, code binding, control round trip, OOB-child visibility repro ===');
  process.exit(0);
}

main().catch((e) => {
  log('SPIKE FAILED:', e.stack ?? e.message);
  process.exit(1);
});
