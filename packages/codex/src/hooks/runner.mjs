#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sendControlCommand } from '../control-server.mjs';
import { resolveDaemonProfile } from '../profile.mjs';
import { readHostHookState } from '../host-hooks.mjs';
import { attachOursClient } from '@ours.network/sdk';
import { prepareAutomaticSession } from '../../../core/src/automatic-session.ts';
import { hostProfileFromEnv } from '../../../core/src/host-client/index.ts';

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

export async function handleHook(payload, { env = process.env, fetch: fetchImpl = globalThis.fetch, send = sendControlCommand, findPin = defaultFindPin, profileResolver = resolveDaemonProfile, clientFactory = attachOursClient, readHostState = readHostHookState, prepareSession = prepareAutomaticSession } = {}) {
  try {
    const event = payload?.hook_event_name;
    const socket = env.OURS_CODEX_CONTROL_SOCKET;
    const capability = env.OURS_CODEX_CAPABILITY;
    if (event === 'SessionStart' && payload.source === 'compact') return { continue: true };
    if (event === 'PostToolUse') {
      if (!socket || !capability || payload.tool_response?.isError) return { continue: true };
      if (!/(choose_identity|create_identity|create_root_identity|create_temporary_identity)$/.test(payload.tool_name || '')) return { continue: true };
      const identity = payload.tool_input?.name;
      if (typeof identity !== 'string' || !identity.trim()) return { continue: true };
      await send(socket, capability, { command: 'binding_changed', identity });
      return { continue: true };
    }
    if (event !== 'SessionStart' && event !== 'UserPromptSubmit') return { continue: true };
    let controlRegistration;
    if (event === 'SessionStart' && socket && capability && payload.session_id && payload.cwd) {
      controlRegistration = await send(socket, capability, { command: 'register_session', sessionId: payload.session_id, threadId: payload.session_id, cwd: payload.cwd });
    }
    if (env.OURS_BIND_IDENTITY?.trim()) return {continue:true};
    let hostProfile;
    try { hostProfile = hostProfileFromEnv(env); }
    catch { return { continue: true }; }
    if (hostProfile) {
      const nativeSessionId = payload.session_id;
      if (typeof nativeSessionId !== 'string' || !nativeSessionId) return { continue: true };
      const appPath = env.OURS_MCP_CONFIG || join(env.HOME || homedir(), '.ours-mcp', 'config.json');
      const state = await readHostState({ profile: hostProfile, nativeSessionId, applicationPath: appPath, harness: 'codex' });
      const pin = await findPin(payload.cwd || process.cwd());
      let registration = '',notice='';
      if(event === 'SessionStart'){
        try {
          const result=await prepareSession(hostProfile,'codex',nativeSessionId,env,{notice:true,source:payload.source,subagent:!!payload.agent_id,projectLabel:typeof payload.cwd==='string'?[...basename(payload.cwd).normalize('NFC').replace(/\p{C}/gu,'').trim()].slice(0,80).join('')||undefined:undefined});
          if(result?.identity && socket && capability && controlRegistration?.state?.boundIdentity !== result.identity.name) await send(socket,capability,{command:'binding_changed',identity:result.identity.name});
          if(result?.identity && (result.showNotice ?? result.identity.created)){notice=`Ours: this session is ${result.identity.displayName}, a temporary identity. When the session ends, Ours deletes it and its message history on this computer. Messages you already sent stay with the people and agents who received them. If the session doesn't end cleanly, deletion may happen later. Say "keep this Ours identity" to make it permanent, or "call yourself <new name>" to rename it.`;registration=notice+' Use keep_identity only on explicit user request; it keeps the same identity, contacts and history. Use rename_identity for a user-given local name; the address stays the same. If NAME_TAKEN, ask for another name without adding a suffix. Use list_local_sessions to find sessions on this computer and address the exact handle shown. Keep the existing Ours Monitor workflow; do not arm it automatically.';}
        }catch(error){registration='Ours session registration unavailable: '+error.message;}
      }
      const context = [registration,renderContext(state.unread.identities, pin)].filter(Boolean).join('\n\n');
      return context ? { continue: true, ...(notice?{systemMessage:notice}:{}), hookSpecificOutput: { hookEventName: event, additionalContext: context } } : { continue: true };
    }

    return { continue: true };
  } catch { return { continue: true }; }
}

async function main() {
  let payload = {};
  try { payload = JSON.parse(readFileSync(0, 'utf8')); } catch { /* noop */ }
  process.stdout.write(JSON.stringify(await handleHook(payload)));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
