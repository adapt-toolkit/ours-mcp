import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { z } from 'zod';
import { sendControlCommand } from './control-server.mjs';

const require = createRequire(import.meta.url);
export const monitorToolNames = ['arm_monitor', 'foreground_monitor', 'disarm_monitor', 'monitor_status'];
const content = (text, isError = false) => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });

const foregroundOffer = (identity) =>
  'IMPORTANT: Before offering the fallback, tell the user exactly: ' +
  '"This standard `codex` session only supports a blocking foreground monitor. ' +
  'For background monitoring, restart the session with `ours-codex` instead; it adds ' +
  'the App Server integration needed for session-scoped background wake." ' +
  'A blocking foreground monitor is available here, but while it waits this Codex session ' +
  'cannot accept another prompt (press Escape to stop it). ' +
  `Ask the user: "Do you want to arm the foreground blocking monitor here?" ` +
  `Only after an explicit yes, call get_messages once to drain existing unread mail, then ` +
  `call foreground_monitor({ identity: ${JSON.stringify(identity)} }).`;

export function foregroundWatchProcess(identity) {
  try {
    const cliPath = require.resolve('@ours.network/mcp/dist/cli.js');
    return { command: process.execPath, args: [cliPath, 'watch', identity] };
  } catch {
    return { command: 'ours-mcp', args: ['watch', identity] };
  }
}

export async function handleMonitorCommand(command, args = {}, { env = process.env, send = sendControlCommand } = {}) {
  const socket = env.OURS_CODEX_CONTROL_SOCKET;
  const capability = env.OURS_CODEX_CAPABILITY;
  if (!socket || !capability) {
    if (command === 'arm') return { text: foregroundOffer(args.identity), mode: 'foreground-offer' };
    if (command === 'disarm') return { text: 'No background monitor is armed. A blocking foreground monitor stops when its tool call is interrupted.' };
    return { text: 'Background mail monitoring is unavailable in this standard Codex session. Use `ours-codex` for background wake, or explicitly arm the blocking foreground monitor for the bound identity.' };
  }
  const wire = command === 'arm' ? { command: 'arm', identity: args.identity }
    : command === 'disarm' ? { command: 'disarm' } : { command: 'status' };
  const response = await send(socket, capability, wire);
  const state = response.state;
  if (command === 'arm') return { text: `Live ours monitor armed for "${state.armedIdentity}". It stops when this Codex CLI session exits.` };
  if (command === 'disarm') return { text: 'Live ours monitor disarmed.' };
  return { text: state.armedIdentity
    ? `Live ours monitor is armed for "${state.armedIdentity}"${state.turnActive ? '; a turn is active' : ''}.`
    : `Live ours monitor is available but not armed${state.boundIdentity ? `; current binding is "${state.boundIdentity}"` : '; bind an identity first'}.` };
}

export function waitForForegroundMail(identity, {
  env = process.env,
  spawnImpl = spawn,
  signal,
  commandFor = foregroundWatchProcess,
} = {}) {
  if (typeof identity !== 'string' || !identity.trim()) return Promise.reject(new Error('identity is required'));

  return new Promise((resolve, reject) => {
    const invocation = commandFor(identity);
    const child = spawnImpl(invocation.command, invocation.args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const stop = () => {
      if (!child.killed) child.kill('SIGTERM');
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      stop();
      fn(value);
    };
    const onAbort = () => finish(reject, new Error('foreground monitor stopped'));

    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    child.once('error', (error) => finish(reject, error));
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
      const newline = stdout.indexOf('\n');
      if (newline === -1) return;
      const event = stdout.slice(0, newline).trim();
      if (event) finish(resolve, event);
    });
    child.once('exit', (code, childSignal) => {
      if (settled) return;
      const detail = stderr.trim() || `exit ${code ?? childSignal ?? 'unknown'}`;
      finish(reject, new Error(`ours-mcp watch stopped before mail arrived: ${detail}`));
    });
  });
}

export function createMonitorMcpServer(deps = {}) {
  const server = new McpServer({ name: 'ours-monitor', version: '0.9.1' });
  server.tool('arm_monitor', 'Arm session-scoped live mail wake for the currently bound ours identity. Call only after explicit user consent. If standard mode is reported, relay its ours-codex background-monitor recommendation to the user verbatim before offering the foreground fallback.', {
    identity: z.string().min(1).describe('The already-bound ours identity to monitor.'),
  }, async ({ identity }) => {
    try { return content((await handleMonitorCommand('arm', { identity }, deps)).text); }
    catch (error) { return content(`Could not arm live monitor: ${error.message}`, true); }
  });
  server.tool('foreground_monitor', 'Block this Codex turn until new mail arrives for the bound ours identity. Never call unless the user was first told that ours-codex provides background monitoring and then explicitly accepted this foreground fallback.', {
    identity: z.string().min(1).describe('The already-bound ours identity to monitor.'),
  }, async ({ identity }, extra) => {
    try {
      const event = await waitForForegroundMail(identity, { ...deps, signal: extra?.signal });
      return content(`Foreground ours monitor received a body-free arrival event: ${event}\nCall get_messages now. After handling the mail, call foreground_monitor again without asking if monitoring should remain armed.`);
    } catch (error) {
      if (extra?.signal?.aborted) return content('Foreground ours monitor stopped. It is no longer armed.');
      return content(`Foreground ours monitor failed: ${error.message}`, true);
    }
  });
  server.tool('disarm_monitor', 'Stop this session’s live ours mail wake monitor.', {}, async () => {
    try { return content((await handleMonitorCommand('disarm', {}, deps)).text); }
    catch (error) { return content(`Could not disarm live monitor: ${error.message}`, true); }
  });
  server.tool('monitor_status', 'Report whether live ours mail wake is available and armed.', {}, async () => {
    try { return content((await handleMonitorCommand('status', {}, deps)).text); }
    catch (error) { return content(`Could not read monitor status: ${error.message}`, true); }
  });
  return server;
}

export async function runMonitorMcp() {
  const server = createMonitorMcpServer();
  await server.connect(new StdioServerTransport());
}
