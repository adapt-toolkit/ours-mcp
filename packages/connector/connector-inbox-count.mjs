#!/usr/bin/env node
// Per-identity non-consuming inbox check (standalone helper / ops-debug). Binds one identity and
// prints its list_incoming_messages (does NOT drain). The gateway's own backstop uses the same
// pattern inline; this file is for manual checks.
//   CONNECTOR_IDENTITY=<id> node connector-inbox-count.mjs
// Config via env: CONNECTOR_CLI, OURS_PORT, OURS_STATE_DIR, OURS_BROKER_URL, CONNECTOR_SESSION_PREFIX.
import { spawn } from 'node:child_process';

const CLI = process.env.CONNECTOR_CLI || 'ours-mcp';
const ID = process.env.CONNECTOR_IDENTITY || (process.env.CONNECTOR_IDENTITIES || 'Peer').split(/\s+/)[0];
const ENV = { ...process.env,
  OURS_PORT: process.env.OURS_PORT || '3050',
  OURS_STATE_DIR: process.env.OURS_STATE_DIR || `${process.env.HOME}/.ours`,
  OURS_BROKER_URL: process.env.OURS_BROKER_URL || 'wss://broker1.ours.network',
  CLAUDE_CODE_SESSION_ID: `${process.env.CONNECTOR_SESSION_PREFIX || 'ours-connector'}-${ID}` };
const proc = spawn(CLI, ['proxy'], { env: ENV, stdio: ['pipe', 'pipe', 'ignore'] });
proc.on('error', e => { console.error('proxy spawn error:', e.message); process.exit(1); });
let buf = ''; const pending = new Map();
proc.stdout.on('data', d => { buf += d.toString(); let i;
  while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!l.trim()) continue; let m; try { m = JSON.parse(l); } catch { continue; }
    if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } });
let id = 1;
const send = (method, params) => new Promise(r => { const i = id++; pending.set(i, r);
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); });
const tool = async (name, args = {}) => { const r = await send('tools/call', { name, arguments: args });
  return (r.result?.content ?? []).map(c => c.text ?? '').join('\n'); };
try {
  await send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'inbox-count', version: '0' } });
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
  await new Promise(r => setTimeout(r, 300));
  await tool('choose_identity', { name: ID, force: true });
  console.log(await tool('list_incoming_messages') || '(empty)');
} finally { proc.stdin.end(); setTimeout(() => proc.kill('SIGTERM'), 300); }
