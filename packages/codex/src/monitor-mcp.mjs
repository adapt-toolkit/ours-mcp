import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { sendControlCommand } from './control-server.mjs';

export const monitorToolNames = ['arm_monitor', 'disarm_monitor', 'monitor_status'];
const content = (text, isError = false) => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });

export async function handleMonitorCommand(command, args = {}, { env = process.env, send = sendControlCommand } = {}) {
  const socket = env.OURS_CODEX_CONTROL_SOCKET;
  const capability = env.OURS_CODEX_CAPABILITY;
  if (!socket || !capability) {
    return { text: 'Live mail monitoring is unavailable in standard Codex mode. Start this session in `ours-codex` live mode to enable it; messaging tools still work normally.' };
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

export function createMonitorMcpServer(deps = {}) {
  const server = new McpServer({ name: 'ours-monitor', version: '0.9.1' });
  server.tool('arm_monitor', 'Arm session-scoped live mail wake for the currently bound ours identity. Call only after explicit user consent.', {
    identity: z.string().min(1).describe('The already-bound ours identity to monitor.'),
  }, async ({ identity }) => {
    try { return content((await handleMonitorCommand('arm', { identity }, deps)).text); }
    catch (error) { return content(`Could not arm live monitor: ${error.message}`, true); }
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
