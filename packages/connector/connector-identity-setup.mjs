#!/usr/bin/env node
// One-shot identity setup (generalized from peer-identity-setup.mjs). Drives `<CLI> proxy` over stdio
// with raw JSON-RPC (zero external deps): create root + leaf identity, bind, set bio/persona.
// Run once before starting the connector. Config via env (see connector.config.sh):
//   CONNECTOR_CLI, OURS_PORT, OURS_STATE_DIR, OURS_BROKER_URL, CONNECTOR_SESSION_ID,
//   CONNECTOR_ROOT_NAME, CONNECTOR_IDENTITY, CONNECTOR_BIO, CONNECTOR_PERSONA.
// Name charset: letters/digits/space/_.- only (no parens or slash).
import { spawn } from 'node:child_process';

const CLI = process.env.CONNECTOR_CLI || 'ours-mcp';
const ENV = { ...process.env,
  OURS_PORT: process.env.OURS_PORT || '3050',
  OURS_STATE_DIR: process.env.OURS_STATE_DIR || `${process.env.HOME}/.ours`,
  OURS_BROKER_URL: process.env.OURS_BROKER_URL || 'wss://broker1.ours.network',
  CLAUDE_CODE_SESSION_ID: process.env.CONNECTOR_SESSION_ID || 'ours-connector',
  OURS_CLIENT_PID: String(process.pid) };
const ROOT_NAME = process.env.CONNECTOR_ROOT_NAME || 'Ours Connector Peer';
const LEAVES = (process.env.CONNECTOR_IDENTITIES || process.env.CONNECTOR_IDENTITY || 'Peer').split(/\s+/).filter(Boolean);
const BIO = process.env.CONNECTOR_BIO || 'ours.network connector peer (webhook-bridged harness). Coordination over ours.network.';
const persona = (name) => process.env.CONNECTOR_PERSONA || `You are ${name}. Bind ONLY ${name}; never choose_identity another name, never use force. Coordinate over ours.network.`;

const proc = spawn(CLI, ['proxy'], { env: ENV, stdio: ['pipe', 'pipe', 'inherit'] });
let buf = ''; const pending = new Map();
proc.stdout.on('data', (d) => { buf += d.toString(); let i;
  while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue; let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } } });
let nextId = 1;
const send = (method, params) => new Promise((resolve) => { const id = nextId++; pending.set(id, resolve);
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
const notify = (method, params) => proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
const tool = async (name, args = {}) => {
  const r = await send('tools/call', { name, arguments: args });
  const text = (r.result?.content ?? []).map((c) => c.text ?? '').join('\n');
  return { ok: r.result && !r.result.isError, text: text || (r.error ? 'ERR: ' + JSON.stringify(r.error) : '') };
};
const log = (label, r) => console.log(`${label}: ok=${r.ok} «${(r.text || '').slice(0, 120)}»`);
try {
  await send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'connector-setup', version: '0' } });
  notify('notifications/initialized', {});
  await new Promise((r) => setTimeout(r, 300));
  log('create_root_identity', await tool('create_root_identity', { name: ROOT_NAME, expose_local: false, bio: BIO }));
  for (const leaf of LEAVES) {                 // one role per subagent (all under the shared root)
    log('create_identity ' + leaf, await tool('create_identity', { name: leaf, expose_local: false, bio: BIO }));
    await tool('choose_identity', { name: leaf });
    await tool('set_bio', { bio: BIO });
    await tool('set_persona', { persona: persona(leaf) });
  }
  log('list_identities', await tool('list_identities'));
  console.log(`\nDONE — created ${LEAVES.length} identit${LEAVES.length === 1 ? 'y' : 'ies'} (${LEAVES.join(', ')}) under root "${ROOT_NAME}". Each subagent binds its own; exchange invites with peers.`);
} finally { proc.stdin.end(); setTimeout(() => proc.kill('SIGTERM'), 500); }
