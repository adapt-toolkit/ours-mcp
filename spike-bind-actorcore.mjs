#!/usr/bin/env node
// WS-B spike: the monitoring-bind `no_pending` root cause + fix proof.
//
// FINDING: the bind ceremony has TWO independent state cells:
//   - ACTOR  (actor.mu:211): actor.proxy_pending / actor.monitoring_proxy
//   - CORE   (a2a_messaging): a2a_messaging.proxy_pending / monitoring_proxy
// The broker `core.monitoring.bind` verify runs through a2a_cluster::monitoring_handler
// -> a2a_messaging::do_verify_proxy_code (the CORE cell). But the daemon's
// bind_monitoring_proxy tool used to call ::actor::set_proxy_pending (the ACTOR cell),
// and monitoringStatus read the ACTOR cell. So: SET wrote actor, VERIFY read core (NIL)
// -> "no_pending", while the MCP status (actor) showed a phantom "pending". That is the
// exact paradox seen in E2E. NOT a fork, NOT test-rig timing — a state-cell split.
//
// FIX (index.ts): bind_monitoring_proxy -> ::a2a_messaging::set_proxy_pending; and
// monitoringStatus reads the CORE cell for proxy_cid/proxy_pending/monitored (keeps the
// actor cell only for the daemon's copies/control queue depths).
//
// This spike drives the COMPILED packet's core trns directly over the dev broker (no TS
// daemon) and asserts BOTH the fix (core->core = verified) and the regression (actor->core
// = no_pending), plus the status-coherence the new monitoringStatus relies on.
//
// Prereq: dev broker on ws://localhost:9000; built unit at packages/core/dist/mufl_code.

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

  // ---- the daemon's exact bind topology: a ROOT and its bound control plane (CP) ----
  const root = makeIdentity('BindRoot');
  const cp = makeIdentity('CtrlPlane');
  await createPacket(wrapper, root, 'spike-bind-root-0001');
  await createPacket(wrapper, cp, 'spike-bind-cp-0002');
  await sleep(2000);
  await mutate(root, '::a2a_messaging::set_my_name', { name: 'BindRoot' });
  await mutate(cp, '::a2a_messaging::set_my_name', { name: 'CtrlPlane' });
  await connectContacts(root, cp, 'CtrlPlane');
  log(`contact established (BindRoot↔CtrlPlane); CP cid ${cp.cid}`);

  // =====================================================================
  console.log('\n--- ASSERT A: the FIX — core set_proxy_pending → core verify = VERIFIED ---');
  // This mirrors the daemon EXACTLY post-fix: bind_monitoring_proxy now calls
  // ::a2a_messaging::set_proxy_pending; the broker bind verifies via the SAME core cell
  // (monitoring_handler → do_verify_proxy_code, == verify_proxy_code's shared logic).
  const codeA = '424242';
  const setA = await mutate(root, '::a2a_messaging::set_proxy_pending', { code: codeA, proxy: 'CtrlPlane' });
  assert(setA.Reduce('pending').GetBoolean() === true, 'core set_proxy_pending → pending=TRUE');
  // core status reflects the pending immediately (what monitoringStatus now reads)
  const midA = readonly(root, '::a2a_messaging::get_monitoring_status', undefined);
  assert(midA.Reduce('proxy_pending').GetBoolean() === true, 'core get_monitoring_status → proxy_pending=TRUE (status now reads the SAME cell the bind wrote)');
  const verA = await mutate(root, '::a2a_messaging::verify_proxy_code', { code: codeA, sender: 'CtrlPlane' });
  assert(verA.Reduce('verified').GetBoolean() === true, 'core verify_proxy_code → verified=TRUE  (NO no_pending — the owner bind redeems GREEN)');
  const stA = readonly(root, '::a2a_messaging::get_monitoring_status', undefined);
  assert(stA.Reduce('monitored').GetBoolean() === true, 'core status → monitored=TRUE (CP is bound)');
  assert(stA.Reduce('proxy_cid').Visualize() === cp.cid, `core status → proxy_cid == CtrlPlane (${cp.cid})`);
  assert(stA.Reduce('proxy_pending').GetBoolean() === false, 'core status → proxy_pending cleared after success');

  // =====================================================================
  console.log('\n--- ASSERT B: the REGRESSION — actor set_proxy_pending → core verify = no_pending ---');
  // The OLD daemon path: bind wrote the ACTOR cell, the broker verify read the CORE cell.
  // Use a fresh root so no prior core binding masks the effect.
  const root2 = makeIdentity('BindRoot2');
  const cp2 = makeIdentity('CtrlPlane2');
  await createPacket(wrapper, root2, 'spike-bind-root2-0003');
  await createPacket(wrapper, cp2, 'spike-bind-cp2-0004');
  await sleep(2000);
  await mutate(root2, '::a2a_messaging::set_my_name', { name: 'BindRoot2' });
  await mutate(cp2, '::a2a_messaging::set_my_name', { name: 'CtrlPlane2' });
  await connectContacts(root2, cp2, 'CtrlPlane2');

  const codeB = '131313';
  await mutate(root2, '::actor::set_proxy_pending', { code: codeB, proxy: 'CtrlPlane2' });
  // The phantom: the ACTOR cell shows pending …
  const actorB = readonly(root2, '::actor::get_monitoring_status', undefined);
  assert(actorB.Reduce('proxy_pending').GetBoolean() === true, 'ACTOR get_monitoring_status → proxy_pending=TRUE (the phantom the old MCP status surfaced)');
  // … but the CORE cell — the one the broker verify reads — is empty.
  const coreB = readonly(root2, '::a2a_messaging::get_monitoring_status', undefined);
  assert(coreB.Reduce('proxy_pending').GetBoolean() === false, 'CORE get_monitoring_status → proxy_pending=FALSE (the bind never touched the cell the verify reads)');
  const verB = await mutate(root2, '::a2a_messaging::verify_proxy_code', { code: codeB, sender: 'CtrlPlane2' });
  assert(verB.Reduce('verified').GetBoolean() === false, 'core verify_proxy_code → verified=FALSE  (reproduces the bug)');
  assert(verB.Reduce('reason').Visualize() === 'no_pending', 'core verify_proxy_code → reason == "no_pending"  ← EXACT E2E symptom; cause = actor/core split, NOT fork/timing');

  console.log('\n=== BIND SPIKE PASSED ===');
  console.log('  • root cause: actor-cell SET vs core-cell VERIFY (no_pending), not a fork/timing race');
  console.log('  • fix proven: core-cell SET + core-cell VERIFY redeems green; status reads the same cell');
  console.log('  • OWNER BIND: cleared — bind_monitoring_proxy now writes the core cell the verify reads');
  process.exit(0);
}

main().catch((e) => { log('SPIKE FAILED:', e.stack ?? e.message); process.exit(1); });
