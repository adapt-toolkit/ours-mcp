#!/usr/bin/env node
// WS-B: prove §7/§8 — an async cluster verb (create) yields EXACTLY ONE response per req_id
// (the final {cid}), with NO {pending:true} pre-ack — through the live :3031 daemon.
// Binds a controller CP over the broker, sends create, then drains the CP's OWN control-inbox
// (where the daemon's a2a_control responses land) and counts responses for the create req_id.

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
const RUN = String(Date.now()).slice(-7);
const CP_NAME = `e2e-ctl-${RUN}`;
const CHILD = `probe-child-${RUN}`;
const CREATE_REQ = `create-${RUN}`;

const log = (...a) => process.stderr.write(`[1resp] ${a.join(' ')}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (m) => console.log(`  ✓ ${m}`);

function makeIdentity(name) { return { name, pw: null, cid: '', pending: [] }; }
function wireHandlers(id) {
  id.pw.on_return_data = (data) => {
    const kind = data.Reduce('kind').Visualize();
    if (kind === 'save_state' || kind === 'notify_agent') return;
    const p = id.pending.shift(); if (!p) return; clearTimeout(p.timer); p.resolve(data.Reduce('payload'));
  };
  id.pw.on_transaction_failure = (msg) => {
    const p = id.pending.shift();
    if (p) { clearTimeout(p.timer); p.reject(new Error(msg)); } else { log(`${id.name} inbound rejected:`, msg); }
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
    const t = setTimeout(() => rej(new Error(`${id.name} create timed out`)), 30_000);
    wrapper.packet_manager.create_packet(config, (pw) => {
      clearTimeout(t); id.pw = pw; id.cid = pw.packet.GetContainerID().Visualize(); wireHandlers(id); res();
    }, UNIT_CONTENTS);
  });
}
// drain the CP's own control_inbox; return the parsed payloads
async function drainControl(cp) {
  const data = await mutate(cp, '::actor::get_control_requests', {});
  const reqs = data.Reduce('requests');
  const out = [];
  for (let i = 0; ; i++) {
    const m = reqs.Reduce(i); if (m.IsNil()) break;
    try { out.push(JSON.parse(m.Reduce('payload').Visualize())); } catch { /* skip */ }
  }
  return out;
}

async function main() {
  const mcp = new Client({ name: 'wsb-1resp', version: '1.0.0' });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(MCP_URL)));
  const tool = async (name, args = {}) => {
    const r = await mcp.callTool({ name, arguments: args });
    const text = (r.content || []).map((c) => c.text || '').join('\n');
    if (r.isError) throw new Error(`MCP ${name} -> ${text}`);
    return text;
  };

  await tool('choose_identity', { name: 'dev-root2' });
  const rootCid = ((await tool('current_identity')).match(/[0-9A-F]{64}/) || [])[0];
  const invBlob = (await tool('generate_invite', { name: CP_NAME })).trim().split(/\s+/).pop();
  ok(`host minted controller invite for ${CP_NAME}`);

  const wrapper = await adapt_wrapper.start([
    '--broker_address', BROKER_URL, '--test_mode',
    '--logger_config', '--level', 'ERROR', '--stdout', 'stderr', '--logger_config_end',
  ]);
  wrapper.start();
  await sleep(1500);
  const cp = makeIdentity(CP_NAME);
  await createPacket(wrapper, cp, `wsb-1resp-cp-${RUN}`);
  await sleep(1200);
  await mutate(cp, '::a2a_messaging::set_my_name', { name: CP_NAME });
  await mutate(cp, '::a2a_messaging::add_contact', { invite: bin(cp, Buffer.from(invBlob, 'base64url')) });
  await sleep(5000);
  ok('controller CP redeemed invite (mutual contact)');

  // bind the CP as controller (required: cluster verbs are controller-gated)
  const code = ((await tool('bind_monitoring_proxy', { contact: CP_NAME })).match(/code:\s*(\d{6})/) || [])[1];
  await mutate(cp, '::a2a_control::send_control', { contact: rootCid, payload: JSON.stringify({ cap: 'core.monitoring', verb: 'bind', args: { code }, req_id: `bind-${RUN}` }) });
  let bound = false;
  for (let i = 0; i < 20 && !bound; i++) { await sleep(1000); bound = /monitoring proxy bound/.test(await tool('get_monitoring_status')); }
  if (!bound) throw new Error('controller bind did not land');
  ok('controller bound');
  await drainControl(cp); // clear the bind response from the CP inbox

  // === the test: send create, collect EVERY response for CREATE_REQ over a window ===
  await mutate(cp, '::a2a_control::send_control', { contact: rootCid, payload: JSON.stringify({ cap: 'core.cluster', verb: 'create', args: { name: CHILD, bio: 'single-response probe' }, req_id: CREATE_REQ }) });
  ok(`sent create(${CHILD}) req_id=${CREATE_REQ}`);
  const responses = [];
  for (let i = 0; i < 12; i++) { // ~12s window — long enough for pre-ack AND the async {cid}
    await sleep(1000);
    for (const p of await drainControl(cp)) if (p && p.req_id === CREATE_REQ) responses.push(p);
  }

  console.log(`\n  responses for ${CREATE_REQ}: ${responses.length}`);
  responses.forEach((r, i) => console.log(`    [${i}] ${JSON.stringify(r)}`));
  const pre = responses.filter((r) => r.result && r.result.pending === true);
  const fin = responses.filter((r) => r.result && typeof r.result.cid === 'string');
  if (pre.length !== 0) throw new Error(`FAIL: ${pre.length} out-of-contract {pending:true} pre-ack(s) shipped`);
  if (responses.length !== 1) throw new Error(`FAIL: expected exactly 1 response, got ${responses.length}`);
  if (fin.length !== 1) throw new Error('FAIL: the single response does not carry a {cid}');
  ok(`EXACTLY ONE response, and it is the final {cid:${fin[0].result.cid.slice(0, 12)}…} — no pre-ack`);

  console.log('\n=== SINGLE-RESPONSE E2E PASSED — create returns one {cid}, §7/§8 conformant ===');
  await mcp.close();
  process.exit(0);
}
main().catch((e) => { log('FAILED:', e.stack ?? e.message); process.exit(1); });
