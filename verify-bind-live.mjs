#!/usr/bin/env node
// WS-B LIVE E2E: the FULL monitoring-bind ceremony through the RUNNING :3031 daemon.
// Drives the daemon root (dev-root2) via its HTTP MCP, AND acts as the control-plane (CP)
// peer over the dev broker (ws://localhost:9000) so the verify leg is the genuine broker
// `core.monitoring.bind` path (process_control_envelope -> dispatch -> monitoring_handler
// -> a2a_messaging::do_verify_proxy_code). Proves the fixed bind-cell change redeems GREEN
// (monitored, NO no_pending) on the live daemon — the OWNER blocker.
//
// Prereq: :3031 daemon (fixed build) + dev broker ws://localhost:9000 both UP.

import { resolve } from 'node:path';
import * as fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { adapt_wrapper } from '@adapt-toolkit/sdk/executables';
import { PacketWrapperConfigurator } from '@adapt-toolkit/sdk/wrappers';
import { object_to_adapt_value } from '@adapt-toolkit/sdk/wrapper';

const MCP_URL = 'http://localhost:3031/mcp';
const BROKER_URL = 'ws://localhost:9000';
const UNIT_DIR = resolve('packages/core/dist/mufl_code');
const unitHash = fs.readdirSync(UNIT_DIR).find((f) => f.endsWith('.muflo')).slice(0, -'.muflo'.length);
const UNIT_CONTENTS = new Uint8Array(fs.readFileSync(resolve(UNIT_DIR, `${unitHash}.muflo`)));
const RUN = String(Date.now()).slice(-7); // fresh per run → fresh CP cid (no deterministic re-redeem deadlock)
const CP_NAME = `LiveCP-wsb-${RUN}`;

const log = (...a) => process.stderr.write(`[live] ${a.join(' ')}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => { throw new Error(`ASSERT FAILED: ${m}`); };

// ---- broker-side CP packet (SDK), same helpers as the spikes ----
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
  // ---- connect to the live daemon over HTTP MCP ----
  const mcp = new Client({ name: 'wsb-live-e2e', version: '1.0.0' });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(MCP_URL)));
  const tool = async (name, args = {}) => {
    const r = await mcp.callTool({ name, arguments: args });
    const text = (r.content || []).map((c) => c.text || '').join('\n');
    if (r.isError) throw new Error(`MCP ${name} -> ${text}`);
    return text;
  };
  log(`MCP connected ${MCP_URL}`);

  // 1) bind the daemon session to the host root, read its cid
  await tool('choose_identity', { name: 'dev-root2' });
  const cur = await tool('current_identity');
  const rootCid = (cur.match(/[0-9A-F]{64}/) || [])[0];
  if (!rootCid) fail(`could not read root cid from current_identity: ${cur}`);
  ok(`daemon session bound to dev-root2 (root cid ${rootCid})`);

  // 2) host root mints an invite for the CP
  const invText = await tool('generate_invite', { name: CP_NAME });
  const inviteBlob = invText.trim().split(/\s+/).pop();
  if (!inviteBlob || inviteBlob.length < 100) fail(`generate_invite returned no blob: ${invText}`);
  ok(`host minted invite for "${CP_NAME}" (${inviteBlob.length}-char blob)`);

  // 3) bring up the CP over the broker and redeem the invite (mutual contact)
  const wrapper = await adapt_wrapper.start([
    '--broker_address', BROKER_URL, '--test_mode',
    '--logger_config', '--level', 'ERROR', '--stdout', 'stderr', '--logger_config_end',
  ]);
  wrapper.start();
  await sleep(1500);
  const cp = makeIdentity(CP_NAME);
  await createPacket(wrapper, cp, `wsb-live-cp-${RUN}`);
  await sleep(1500);
  await mutate(cp, '::a2a_messaging::set_my_name', { name: CP_NAME });
  await mutate(cp, '::a2a_messaging::add_contact', { invite: bin(cp, Buffer.from(inviteBlob, 'base64url')) });
  await sleep(5000); // let the invite-reply handshake settle so the root registers the CP back
  ok(`CP redeemed invite; mutual contact with dev-root2 established (CP cid ${cp.cid})`);

  // 4) host root starts the bind ceremony for the CP -> 6-digit code (out-of-band)
  const bindText = await tool('bind_monitoring_proxy', { contact: CP_NAME });
  const code = (bindText.match(/Verification code:\s*(\d{6})/) || [])[1];
  if (!code) fail(`bind_monitoring_proxy returned no code: ${bindText}`);
  ok(`bind_monitoring_proxy → pending set on the CORE cell; code ${code}`);
  // confirm the daemon reports pending (status now reads the same core cell the bind wrote)
  const pre = await tool('get_monitoring_status');
  if (!/proxy code verification is pending/.test(pre)) fail(`status did not show pending: ${pre}`);
  ok('get_monitoring_status → "a proxy code verification is pending" (core cell, consistent)');

  // 5) the CP sends the genuine broker bind envelope (the verify leg)
  const envelope = { cap: 'core.monitoring', verb: 'bind', args: { code }, req_id: 'wsb-live-1' };
  await mutate(cp, '::a2a_control::send_control', { contact: rootCid, payload: JSON.stringify(envelope) });
  ok('CP sent core.monitoring.bind over the broker → daemon dispatch → monitoring_handler');

  // 6) poll the daemon until the binding lands
  let boundCid = '';
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const st = await tool('get_monitoring_status');
    const m = st.match(/monitoring proxy bound:\s*([0-9A-F]{64})/);
    if (m) { boundCid = m[1]; console.log(`\n  daemon status:\n${st.split('\n').map((l) => '    ' + l).join('\n')}`); break; }
  }
  if (!boundCid) fail('binding never landed — get_monitoring_status still reports no proxy bound (no_pending or undelivered)');
  if (boundCid !== cp.cid) fail(`bound proxy_cid ${boundCid} != CP cid ${cp.cid}`);
  ok(`BIND GREEN — daemon bound the CP as monitoring proxy (proxy_cid == CP ${boundCid})`);

  console.log('\n=== LIVE BIND E2E PASSED — owner blocker cleared on the running :3031 daemon ===');
  await mcp.close();
  process.exit(0);
}

main().catch(async (e) => { log('LIVE E2E FAILED:', e.stack ?? e.message); process.exit(1); });
