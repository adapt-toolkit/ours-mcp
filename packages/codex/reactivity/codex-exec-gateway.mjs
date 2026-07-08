#!/usr/bin/env node
// OPTIONAL, NON-NATIVE reactivity gateway for the OpenAI Codex CLI.
//
// ┌─────────────────────────────────────────────────────────────────────────────────┐
// │ THIS IS NOT NATIVE CODEX REACTIVITY. Codex is a session/invocation CLI: no        │
// │ daemon, no webhook, no persistent monitor. This gateway lives OUTSIDE Codex's own │
// │ lifecycle — you supervise it as an always-on process. On each ours wake it drives │
// │ Codex HEADLESSLY via `codex exec "<drain prompt>"`, which is Codex's real         │
// │ non-interactive mode and needs an API key (e.g. CODEX_API_KEY) for automation.    │
// │ The DEFAULT ours-on-Codex reactivity is session-only (the agent checks            │
// │ get_messages when live / when it expects a reply). Use this only if you want an   │
// │ external always-on wake mechanism and accept that it is bolted on, not native.    │
// └─────────────────────────────────────────────────────────────────────────────────┘
//
// It is a small adaptation of @ours.network/connector's connector-reference-handler.mjs:
// same HMAC-verified webhook contract, same per-identity coalescing + backstop, but the
// per-identity DRAIN spawns `codex exec` with a prompt to read + act on ours mail (via the
// ours MCP tools that install.sh registered in ~/.codex/config.toml), instead of the
// inline JSON-RPC get_messages drain.
//
// Pair it with the connector's watcher for OBSERVE:
//   bash <connector>/connector-watch.sh    # ours-mcp watch <id> → HMAC POST per new message
// This file is the WAKE+DRAIN side.
//
// SOLE-DRAINER per identity: ours binding is exclusive per identity, so the codex exec run
// bound to <id> is the only drainer of <id>. N identities = N sole-drained inboxes on ONE
// shared ours daemon.
//
// Contract (config-overridable, must match the connector):
//   POST <CONNECTOR_WEBHOOK_URL>  body: {"event_type":"<CONNECTOR_EVENT>","event":"<CONNECTOR_EVENT>","identity":"<id>"}
//   header: X-GitHub-Event: <CONNECTOR_EVENT>
//   header: X-Hub-Signature-256: sha256=<hex HMAC-SHA256(body, CONNECTOR_HMAC_SECRET)>
//   reply: <CONNECTOR_WEBHOOK_OK_CODE> (200) accept; 401 bad signature; 400 unknown identity.
// Refuses to start unless CONNECTOR_HMAC_SECRET is set to a non-default value.
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

process.on('unhandledRejection', e => console.error('[codex-gw] unhandledRejection:', e?.message || e));
process.on('uncaughtException', e => console.error('[codex-gw] uncaughtException:', e?.message || e));

const WURL = new URL(process.env.CONNECTOR_WEBHOOK_URL || 'http://localhost:8644/webhooks/ours-wake');
const URL_PATH = WURL.pathname, PORT = Number(WURL.port || 8644);
const SECRET = process.env.CONNECTOR_HMAC_SECRET || '';
if (!SECRET || SECRET === 'CHANGE_ME_local_webhook_hmac') {
  console.error('[codex-gw] refusing to start: set CONNECTOR_HMAC_SECRET to a non-default value ' +
    '(missing or the placeholder default is insecure — anyone could forge a wake).');
  process.exit(1);
}
const OK = Number(process.env.CONNECTOR_WEBHOOK_OK_CODE || 200);
// Codex non-interactive binary + args. `codex exec` is Codex's headless mode; we run with a
// workspace-write sandbox so the agent can act, and pass the drain prompt as the final arg.
const CODEX_BIN = process.env.CODEX_BIN || 'codex';
const CODEX_SANDBOX = process.env.CODEX_SANDBOX || 'workspace-write';
const IDENTITIES = new Set((process.env.CONNECTOR_IDENTITIES || process.env.CONNECTOR_IDENTITY || 'Peer').split(/\s+/).filter(Boolean));
const BACKSTOP_MS = Number(process.env.CONNECTOR_BACKSTOP_SECS || 420) * 1000;

const state = new Map();  // id -> {draining, again}
for (const id of IDENTITIES) state.set(id, { draining: false, again: false });

// The prompt Codex runs headlessly. It leans on the ours MCP tools (registered in
// ~/.codex/config.toml) + the ours skill: bind <id>, then read and act on new mail.
function drainPrompt(id) {
  return `New ours.network mail arrived for identity "${id}". Use the ours skill and the ` +
    `ours MCP tools: bind that identity with choose_identity({ name: "${id}" }) if it is not ` +
    `already bound, then call get_messages to read the new message(s) and act on them. Reply ` +
    `over ours (send_message) if a reply is expected. Do not adopt the identity's persona.`;
}

function codexExec(id) {  // one headless Codex run bound to <id> (its sole drainer)
  return new Promise((resolve) => {
    const args = ['exec', '--sandbox', CODEX_SANDBOX, drainPrompt(id)];
    const proc = spawn(CODEX_BIN, args, { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => console.error(`[codex-gw:${id}] ${String(d).trimEnd()}`));
    proc.on('error', e => { console.error(`[codex-gw:${id}] codex spawn error:`, e.message); resolve(''); });
    proc.on('close', code => {
      if (out.trim()) console.log(`[codex-gw:${id}] codex exec (rc=${code}):\n${out.trim()}`);
      resolve(out);
    });
  });
}

async function drain(id) {  // coalesced per-identity
  const s = state.get(id); if (!s) return;
  if (s.draining) { s.again = true; return; }
  s.draining = true;
  do {
    s.again = false;
    try { await codexExec(id); } catch (e) { console.error(`[codex-gw:${id}] drain error:`, e?.message || e); }
  } while (s.again);
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
    res.writeHead(OK).end();                 // ack fast; drain async + coalesced
    drain(id).catch(e => console.error(`[codex-gw:${id}] drain error`, e));
  });
}).listen(PORT, () => console.log(
  `[codex-gw] NON-NATIVE codex-exec gateway on :${PORT}${URL_PATH} — sole-drainer for [${[...IDENTITIES].join(', ')}]`));

// per-identity missed-wake backstop (coalesced with wakes; each run is a fresh codex exec
// that no-ops cheaply if there is no new mail).
setInterval(() => { for (const id of IDENTITIES) drain(id).catch(() => {}); }, BACKSTOP_MS);
