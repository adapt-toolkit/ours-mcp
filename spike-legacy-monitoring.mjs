#!/usr/bin/env node
// Tester spike for the chunk-2 regression (assert 3): a LEGACY FLAT persisted blob
// with the APP's monitoring armed (top-level $monitoring_proxy, NO $core key) must
// import WITHOUT arming core's hidden forced-monitoring — i.e. core
// get_monitoring_status $monitored stays FALSE. The app can never arm core.
//
// Faithful flat blob: a root P binds an app-level monitoring proxy (actor ceremony
// set_proxy_pending + verify_proxy_code → actor.monitoring_proxy armed), export_state,
// then we promote $core's genuine identity fields to TOP LEVEL and DROP the $core key,
// keeping the armed top-level (app) $monitoring_proxy. That is byte-faithful to what
// export_state emitted before commit 18c3652 (the namespacing fix). object_to_adapt_value
// passes AdaptValue leaves through unchanged, so the typed proxy_binding_t/global_id/time
// survive intact. Import into a FRESH packet on the 2.2 unit → assert.
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

  const root = makeIdentity('LegacyRoot');
  const cp = makeIdentity('AppProxy');
  await createPacket(wrapper, root, 'spike-legacy-root-0001');
  await createPacket(wrapper, cp, 'spike-legacy-proxy-0002');
  await sleep(2000);
  await mutate(root, '::a2a_messaging::set_my_name', { name: 'LegacyRoot' });
  await mutate(cp, '::a2a_messaging::set_my_name', { name: 'AppProxy' });
  await connectContacts(root, cp, 'AppProxy');
  log('contact established (LegacyRoot↔AppProxy)');

  // ---- arm APP-LEVEL monitoring on the root (actor ceremony) ----
  await mutate(root, '::actor::set_proxy_pending', { code: '654321', proxy: 'AppProxy' });
  const verdict = await mutate(root, '::actor::verify_proxy_code', { code: '654321', sender: 'AppProxy' });
  assert(verdict.Reduce('verified').GetBoolean() === true, 'app-level monitoring proxy bound on the root (verify_proxy_code → verified)');
  const armed = readonly(root, '::actor::get_monitoring_status', undefined);
  assert(armed.Reduce('proxy_cid').Visualize() === cp.cid, `root's APP-level monitoring is armed (actor proxy_cid == AppProxy ${cp.cid})`);
  // Baseline: the app ceremony did NOT arm CORE's forced monitoring.
  const coreBefore = readonly(root, '::a2a_messaging::get_monitoring_status', undefined);
  assert(coreBefore.Reduce('monitored').GetBoolean() === false, "baseline: arming the APP proxy left CORE forced-monitoring dormant ($monitored==FALSE)");

  // ---- build a faithful LEGACY FLAT blob from the export (drop $core) ----
  const E = readonly(root, '::actor::export_state', undefined);
  const core = E.Reduce('core');
  const flatObj = {
    // required by import_core_state (no nil-guard) — promoted from $core
    my_name:         core.Reduce('my_name'),
    contacts:        core.Reduce('contacts'),
    pending_invites: core.Reduce('pending_invites'),
    peer_ads:        core.Reduce('peer_ads'),
    // inbox bookkeeping (current-shape branch, empty inbox)
    inbox: [],
    next_msg_seq: 1,
    // THE load-bearing field: app-level monitoring ARMED, at TOP LEVEL (no $core)
    monitoring_proxy: E.Reduce('monitoring_proxy'),
  };
  // promote optional identity fields when present (a root has no delegation chain)
  for (const f of ['my_bio', 'delegation_cert', 'root_ad', 'root_profile', 'contact_roots']) {
    const v = core.Reduce(f);
    if (!v.IsNil()) flatObj[f] = v;
  }
  // NOTE: deliberately NO `core` key → import_state takes the legacy flat branch.
  const flat = object_to_adapt_value(flatObj);
  // sanity on the blob we built
  assert(flat.Reduce('core').IsNil(), 'constructed blob has NO $core key (legacy flat shape)');
  assert(!flat.Reduce('monitoring_proxy').IsNil(), 'constructed blob carries an ARMED top-level $monitoring_proxy');
  // round-trip through serialize/parse exactly as the daemon persists it
  const bytes = Buffer.from(flat.Serialize());
  log(`flat legacy blob built (${bytes.length} bytes), no $core, armed top-level monitoring_proxy`);

  // ---- import into a FRESH packet on the 2.2 unit ----
  const fresh = makeIdentity('Upgraded');
  await createPacket(wrapper, fresh, 'spike-legacy-fresh-0003');
  await sleep(1500);
  const parsed = fresh.pw.packet.ParseValue(new Uint8Array(bytes));
  const imp = await mutate(fresh, '::actor::import_state', parsed);
  log(`import_state → imported=${imp.Reduce('imported').Visualize()} contacts=${imp.Reduce('contacts').Visualize()} peers=${imp.Reduce('peers').Visualize()}`);

  console.log('\n--- ASSERT 3: legacy flat blob → CORE monitoring stays dormant ---');
  // THE REGRESSION ASSERT: core forced-monitoring must be dormant.
  const coreStatus = readonly(fresh, '::a2a_messaging::get_monitoring_status', undefined);
  assert(coreStatus.Reduce('monitored').GetBoolean() === false,
    'CORE get_monitoring_status $monitored == FALSE — app monitoring keys NEVER reached core (chunk-2 fix holds)');
  // POSITIVE CONTROL: the app-level monitoring DID restore — proves the blob was genuinely
  // armed, so $monitored==FALSE is meaningful (not because the blob was empty).
  const appStatus = readonly(fresh, '::actor::get_monitoring_status', undefined);
  assert(appStatus.Reduce('proxy_cid').Visualize() === cp.cid,
    `contrast: APP monitoring DID restore from the flat blob (actor proxy_cid == AppProxy ${cp.cid}) — blob genuinely armed`);

  console.log('\n=== LEGACY-MONITORING SPIKE PASSED: app armed, core dormant, app cannot arm core ===');
  process.exit(0);
}

main().catch((e) => { log('SPIKE FAILED:', e.stack ?? e.message); process.exit(1); });
