#!/usr/bin/env node
// REFERENCE gateway-side handler (MULTI-IDENTITY). Documents + implements the receiving contract the
// connector poke()s, and routes each wake to the RIGHT subagent by identity. Any webhook +
// shell-tool-calling harness adapts this: replace the drain-and-act block with the per-subagent
// agent loop for that identity.
//
// SOLE-DRAINER per identity: ours binding is exclusive per identity, so the session bound to <id> is
// the only drainer of <id>. N identities = N independent sole-drained inboxes on ONE shared daemon.
//
// Contract (config-overridable, must match the connector):
//   POST <CONNECTOR_WEBHOOK_URL>  body: {"event":"<CONNECTOR_EVENT>","identity":"<id>"}
//   header: X-Hub-Signature-256: sha256=<hex HMAC-SHA256(body, CONNECTOR_HMAC_SECRET)>
//   reply: <CONNECTOR_WEBHOOK_OK_CODE> (202) accept; 401 bad signature; 400 unknown identity.
// Wakes are COALESCED per-identity. A per-identity BACKSTOP sweep (list→drain-if-unread) covers
// missed wakes (this side owns the bindings, so the backstop lives here, not in the watcher).
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

process.on('unhandledRejection', e => console.error('[gateway] unhandledRejection:', e?.message || e));
process.on('uncaughtException', e => console.error('[gateway] uncaughtException:', e?.message || e));

const WURL = new URL(process.env.CONNECTOR_WEBHOOK_URL || 'http://localhost:8644/webhooks/ours-wake');
const URL_PATH = WURL.pathname, PORT = Number(WURL.port || 8644);
const SECRET = process.env.CONNECTOR_HMAC_SECRET || 'CHANGE_ME_local_webhook_hmac';
const OK = Number(process.env.CONNECTOR_WEBHOOK_OK_CODE || 202);
const CLI = process.env.CONNECTOR_CLI || 'ours-mcp';
const IDENTITIES = new Set((process.env.CONNECTOR_IDENTITIES || process.env.CONNECTOR_IDENTITY || 'Peer').split(/\s+/).filter(Boolean));
const SPREFIX = process.env.CONNECTOR_SESSION_PREFIX || 'ours-connector';
const BASE_ENV = { ...process.env,
  OURS_PORT: process.env.OURS_PORT || '3050',
  OURS_STATE_DIR: process.env.OURS_STATE_DIR || `${process.env.HOME}/.ours`,
  OURS_BROKER_URL: process.env.OURS_BROKER_URL || 'wss://broker1.ours.network' };
const BACKSTOP_MS = Number(process.env.CONNECTOR_BACKSTOP_SECS || 420) * 1000;

const state = new Map();  // id -> {draining, again}
for (const id of IDENTITIES) state.set(id, { draining: false, again: false });

async function rpcDrain(id, force) {  // bind <id> (exclusive → sole drainer), list; get_messages if unread|force
  const env = { ...BASE_ENV, CLAUDE_CODE_SESSION_ID: `${SPREFIX}-${id}` };
  const proc = spawn(CLI, ['proxy'], { env, stdio: ['pipe', 'pipe', 'ignore'] });
  proc.on('error', e => console.error(`[gateway:${id}] proxy spawn error:`, e.message));
  let buf = ''; const pend = new Map(); let n = 1;
  proc.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) {
    const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!l.trim()) continue;
    let m; try { m = JSON.parse(l); } catch { continue; }
    if (m.id != null && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } } });
  const send = (method, params) => new Promise(r => { const i = n++; pend.set(i, r);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); });
  const tool = async (name, args = {}) => { const r = await send('tools/call', { name, arguments: args });
    return (r.result?.content ?? []).map(c => c.text ?? '').join('\n'); };
  try {
    await send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'gw', version: '0' } });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
    await new Promise(r => setTimeout(r, 300));
    await tool('choose_identity', { name: id, force: true });
    if (!force) { const inbox = await tool('list_incoming_messages');
      const unread = Number((inbox.match(/(\d+)\s+unread/) || [])[1] || 0);
      if (unread === 0) return ''; }
    const text = await tool('get_messages');
    // >>> REPLACE with subagent <id>'s agent loop (feed `text` to the model + act) <<<
    if (text && !/no new|inbox is empty/i.test(text)) console.log(`[gateway:${id}] drained:\n${text}`);
    return text;
  } finally { proc.stdin.end(); setTimeout(() => proc.kill('SIGTERM'), 300); }
}

async function drain(id, force) {  // coalesced per-identity
  const s = state.get(id); if (!s) return;
  if (s.draining) { s.again = true; return; }
  s.draining = true;
  do { s.again = false; try { await rpcDrain(id, force); } catch (e) { console.error(`[gateway:${id}] drain error:`, e?.message || e); } force = false; } while (s.again);
  s.draining = false;
}

http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== URL_PATH) { res.writeHead(404).end(); return; }
  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    const sig = (req.headers['x-hub-signature-256'] || '').replace(/^sha256=/, '');
    const good = crypto.createHmac('sha256', SECRET).update(body).digest('hex');
    const okSig = sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
    if (!okSig) { res.writeHead(401).end('bad sig'); return; }
    let id; try { id = JSON.parse(body).identity; } catch {}
    if (!id || !IDENTITIES.has(id)) { res.writeHead(400).end('unknown identity'); return; }
    res.writeHead(OK).end();                 // ack fast; drain async + coalesced, force (wake implies mail)
    drain(id, true).catch(e => console.error(`[gateway:${id}] drain error`, e));
  });
}).listen(PORT, () => console.log(`[gateway] multi-identity handler on :${PORT}${URL_PATH} — sole-drainer for [${[...IDENTITIES].join(', ')}]`));

// per-identity missed-wake backstop (non-consuming check → drain only if unread)
setInterval(() => { for (const id of IDENTITIES) drain(id, false).catch(() => {}); }, BACKSTOP_MS);
