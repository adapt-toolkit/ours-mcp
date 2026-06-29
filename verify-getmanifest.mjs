#!/usr/bin/env node
// WS-B: reproduce the bind-time get_manifest probe — which request FORMS make the daemon
// answer with protocol_version=2 and which omit it. Same fixed dist build as :3033, on an
// isolated throwaway daemon (:3034). A broker probe peer (a contact of the root) sends each
// form via a2a_control and we print the RAW response the daemon ships back.

import { resolve } from 'node:path';
import * as fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { adapt_wrapper } from '@adapt-toolkit/sdk/executables';
import { PacketWrapperConfigurator } from '@adapt-toolkit/sdk/wrappers';
import { object_to_adapt_value } from '@adapt-toolkit/sdk/wrapper';

const MCP_URL = 'http://localhost:3034/mcp';
const BROKER_URL = 'ws://localhost:9000';
const UNIT_DIR = resolve('packages/core/dist/mufl_code');
const unitHash = fs.readdirSync(UNIT_DIR).find((f) => f.endsWith('.muflo')).slice(0, -'.muflo'.length);
const UNIT_CONTENTS = new Uint8Array(fs.readFileSync(resolve(UNIT_DIR, `${unitHash}.muflo`)));
const RUN = String(Date.now()).slice(-7);

const log = (...a) => process.stderr.write(`[mf] ${a.join(' ')}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeIdentity(name) { return { name, pw: null, cid: '', pending: [] }; }
function wireHandlers(id) {
  id.pw.on_return_data = (data) => {
    const kind = data.Reduce('kind').Visualize();
    if (kind === 'save_state' || kind === 'notify_agent') return;
    const p = id.pending.shift(); if (!p) return; clearTimeout(p.timer); p.resolve(data.Reduce('payload'));
  };
  id.pw.on_transaction_failure = (msg) => { const p = id.pending.shift(); if (p) { clearTimeout(p.timer); p.reject(new Error(msg)); } };
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
    wrapper.packet_manager.create_packet(config, (pw) => { clearTimeout(t); id.pw = pw; id.cid = pw.packet.GetContainerID().Visualize(); wireHandlers(id); res(); }, UNIT_CONTENTS);
  });
}
async function drain(cp) {
  const data = await mutate(cp, '::actor::get_control_requests', {});
  const reqs = data.Reduce('requests'); const out = [];
  for (let i = 0; ; i++) { const m = reqs.Reduce(i); if (m.IsNil()) break; out.push(m.Reduce('payload').Visualize()); }
  return out;
}

async function main() {
  const mcp = new Client({ name: 'wsb-mf', version: '1.0.0' });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(MCP_URL)));
  const tool = async (n, a = {}) => { const r = await mcp.callTool({ name: n, arguments: a }); const t = (r.content || []).map((c) => c.text || '').join('\n'); if (r.isError) throw new Error(`${n}: ${t}`); return t; };

  const created = await tool('create_root_identity', { name: `mf-root-${RUN}` });
  const rootCid = (created.match(/[0-9A-F]{64}/) || [])[0];
  await tool('choose_identity', { name: `mf-root-${RUN}` });
  const invBlob = (await tool('generate_invite', { name: 'probe' })).trim().split(/\s+/).pop();
  log(`root mf-root-${RUN} cid ${rootCid}`);

  const wrapper = await adapt_wrapper.start(['--broker_address', BROKER_URL, '--test_mode', '--logger_config', '--level', 'ERROR', '--stdout', 'stderr', '--logger_config_end']);
  wrapper.start();
  await sleep(1500);
  const cp = makeIdentity('probe');
  await createPacket(wrapper, cp, `mf-probe-${RUN}`);
  await sleep(1200);
  await mutate(cp, '::a2a_messaging::set_my_name', { name: 'probe' });
  await mutate(cp, '::a2a_messaging::add_contact', { invite: bin(cp, Buffer.from(invBlob, 'base64url')) });
  await sleep(5000);
  log('probe peer is a contact of the root');

  const FORMS = [
    ['(a) v1 legacy        {v:1,t:"get_manifest"}', { v: 1, t: 'get_manifest', id: `p1-${RUN}` }],
    ['(b) v2 envelope core.cluster.get_manifest',   { cap: 'core.cluster', verb: 'get_manifest', args: {}, req_id: `p2-${RUN}` }],
    ['(c) v2 envelope core.connect.get_manifest',   { cap: 'core.connect', verb: 'get_manifest', args: {}, req_id: `p3-${RUN}` }],
    ['(d) bare/cross-ver  {t:"get_manifest"} no v',  { t: 'get_manifest', id: `p4-${RUN}` }],
    ['(e) v2-tagged       {v:2,t:"get_manifest"}',   { v: 2, t: 'get_manifest', id: `p5-${RUN}` }],
  ];
  const results = [];
  for (const [label, form] of FORMS) {
    await drain(cp); // clear inbox
    await mutate(cp, '::a2a_control::send_control', { contact: rootCid, payload: JSON.stringify(form) });
    let resp = [];
    for (let i = 0; i < 6 && resp.length === 0; i++) { await sleep(1000); resp = await drain(cp); }
    results.push([label, form, resp]);
  }

  console.log('\n========== RAW get_manifest PROBE RESULTS ==========');
  for (const [label, form, resp] of results) {
    console.log(`\n### ${label}`);
    console.log(`  REQUEST : ${JSON.stringify(form)}`);
    if (resp.length === 0) { console.log('  RESPONSE: <none within 6s>'); continue; }
    for (const r of resp) {
      console.log(`  RESPONSE: ${r}`);
      let pv = '(absent)';
      try { const o = JSON.parse(r); const m = o.manifest || (o.result && o.result.manifest) || o.result || o; if (m && m.protocol_version !== undefined) pv = String(m.protocol_version); } catch {}
      console.log(`  -> protocol_version: ${pv}`);
    }
  }
  console.log('\n===================================================');
  await mcp.close();
  process.exit(0);
}
main().catch((e) => { log('FAILED:', e.stack ?? e.message); process.exit(1); });
