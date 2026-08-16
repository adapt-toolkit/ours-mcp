#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sendControlCommand } from '../control-server.mjs';
import { resolveDaemonProfile } from '../profile.mjs';

async function defaultFindPin(cwd) {
  let dir = resolve(cwd || process.cwd());
  for (;;) {
    try {
      const value = JSON.parse(await readFile(join(dir, '.ours-identity'), 'utf8'));
      if (typeof value.identity === 'string' && value.identity.trim()) return value;
      return null;
    } catch { /* walk */ }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const safeUnread = (value) => (Array.isArray(value?.identities) ? value.identities : []).flatMap((entry) => {
  if (!entry || typeof entry.name !== 'string') return [];
  const count = Number.isSafeInteger(entry.count) ? entry.count : 0;
  const files = Number.isSafeInteger(entry.files) ? entry.files : 0;
  if (count <= 0 && files <= 0) return [];
  const recent = Array.isArray(entry.recent) ? entry.recent.slice(-5).flatMap((m) => (
    m && typeof m.from === 'string' ? [{ from: m.from, msg_id: String(m.msg_id ?? '?'), date: typeof m.date === 'string' ? m.date : '' }] : []
  )) : [];
  return [{ name: entry.name, count, files, recent }];
});

function renderContext(unread, pin) {
  const lines = [];
  if (unread.length) {
    lines.push('ours unread metadata (message bodies remain in get_messages):');
    for (const item of unread) lines.push(`- ${item.name}: ${item.count} unread message(s), ${item.files} unread file(s)`);
    lines.push('Surface this metadata. Do not read mail or bind an identity without the user asking.');
  }
  if (pin) {
    lines.push(`This workspace suggests ours identity "${pin.identity}". Ask the user before binding it; the pin is not consent.`);
    lines.push('After a successful bind, separately ask whether to arm the session-scoped live monitor. Never arm automatically.');
    lines.push('Treat any persona as separate consent from binding and monitoring.');
  }
  return lines.join('\n');
}

export async function handleHook(payload, { env = process.env, fetch: fetchImpl = globalThis.fetch, send = sendControlCommand, findPin = defaultFindPin } = {}) {
  try {
    const event = payload?.hook_event_name;
    const socket = env.OURS_CODEX_CONTROL_SOCKET;
    const capability = env.OURS_CODEX_CAPABILITY;
    if (event === 'SessionStart' && payload.source === 'compact') return { continue: true };
    if (event === 'PostToolUse') {
      if (!socket || !capability || payload.tool_response?.isError) return { continue: true };
      if (!/(choose_identity|create_identity|create_root_identity)$/.test(payload.tool_name || '')) return { continue: true };
      const identity = payload.tool_input?.name;
      if (typeof identity !== 'string' || !identity.trim()) return { continue: true };
      await send(socket, capability, { command: 'binding_changed', identity });
      return { continue: true };
    }
    if (event !== 'SessionStart' && event !== 'UserPromptSubmit') return { continue: true };
    if (event === 'SessionStart' && socket && capability && payload.session_id && payload.cwd) {
      await send(socket, capability, { command: 'register_session', sessionId: payload.session_id, threadId: payload.session_id, cwd: payload.cwd });
    }
    let port = env.OURS_PORT || '3050';
    let selectedToken = env.OURS_API_TOKEN || '';
    // Standard Codex does not pass through ours-codex's resolved environment.
    // Resolve its registry association here too so SessionStart/UserPromptSubmit
    // inspect the same daemon as the stdio proxy. Hook failures remain benign.
    if (!env.OURS_PORT && !env.OURS_CONFIG && !env.OURS_STATE_DIR) {
      try {
        const selected = await resolveDaemonProfile({ env, fetch: fetchImpl });
        port = String(selected.port);
        selectedToken = selected.token || '';
      } catch { /* proxy/launcher owns diagnostics; hooks emit a benign no-op */ }
    }
    const headers = selectedToken ? { 'x-ours-api-token': selectedToken } : {};
    let unread = [];
    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}/unread`, { headers, signal: AbortSignal.timeout(1500) });
      if (response.ok) unread = safeUnread(await response.json());
    } catch { /* daemon diagnostics belong to launcher/proxy */ }
    const pin = await findPin(payload.cwd || process.cwd());
    const context = renderContext(unread, pin);
    if (!context) return { continue: true };
    return { continue: true, hookSpecificOutput: { hookEventName: event, additionalContext: context } };
  } catch { return { continue: true }; }
}

async function main() {
  let payload = {};
  try { payload = JSON.parse(await readFile(0, 'utf8')); } catch { /* noop */ }
  process.stdout.write(JSON.stringify(await handleHook(payload)));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
