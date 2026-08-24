// Agent-facing MCP adapters over `@ours.network/sdk`. The SDK owns identity and
// transport behavior; this package defines the MCP vocabulary, schemas, and
// rendering. One SDK client is retained for each MCP session so binding changes
// and later tool calls share the same live session state.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { OursClient } from '@ours.network/sdk';

import type { ApplicationIdentityStore } from '../application-identities.js';
import { registerContactsTools } from './tools/contacts.js';
import { registerFilesTools } from './tools/files.js';
import { registerHistoryTools } from './tools/history.js';
import { registerIdentityTools } from './tools/identity.js';
import { registerMessagingTools } from './tools/messaging.js';
import { registerProfileTools } from './tools/profile.js';

/**
 * Build one per-session MCP server around the already-attached shared-daemon
 * client.
 */
export function createOursMcpServer(
  client: OursClient,
  version: string,
  applicationIdentities: ApplicationIdentityStore,
): McpServer {
  const server = new McpServer(
    { name: 'ours', version },
    { capabilities: { logging: {} } },
  );

  const clientFor = () => client;

  registerIdentityTools(server, clientFor, applicationIdentities);
  registerContactsTools(server, clientFor);
  registerProfileTools(server, clientFor);
  registerMessagingTools(server, clientFor);
  registerFilesTools(server, clientFor);
  registerHistoryTools(server, clientFor);

  return server;
}
