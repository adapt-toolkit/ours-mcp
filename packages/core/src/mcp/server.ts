// Agent-facing MCP adapters over `@ours.network/sdk`. The SDK owns identity and
// transport behavior; this package defines the MCP vocabulary, schemas, and
// rendering. One SDK client is retained for each MCP session so binding changes
// and later tool calls share the same live session state.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { OursClient } from '@ours.network/sdk';

import type { ApplicationIdentityStore } from '../application-identities.js';
import type { OursClientProvider } from './tool.js';
import { registerCommandTools } from './tools/commands.js';
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
  client: OursClient | OursClientProvider,
  version: string,
  applicationIdentities: ApplicationIdentityStore,
  options: { networkHostFiles?: boolean } = {},
): McpServer {
  const server = new McpServer(
    { name: 'ours', version },
    { capabilities: { logging: {} } },
  );

  const clientFor: OursClientProvider = typeof client === 'function' ? client : () => client;

  if (options.networkHostFiles) {
    server.resource(
      'application-identities',
      'ours://application-identities',
      { mimeType: 'application/json', description: 'Application-visible identities for this daemon instance.' },
      async (uri) => ({
        contents: [{
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify({ identities: await applicationIdentities.list() }),
        }],
      }),
    );
  }

  registerIdentityTools(server, clientFor, applicationIdentities, options);
  registerContactsTools(server, clientFor);
  registerProfileTools(server, clientFor);
  registerMessagingTools(server, clientFor, options);
  registerCommandTools(server, clientFor);
  registerFilesTools(server, clientFor, options);
  registerHistoryTools(server, clientFor);

  return server;
}
