import type { FileExecutionContext } from './file-context.js';
// Agent-facing MCP adapters over `@ours.network/sdk`. The SDK owns identity and
// transport behavior; this package defines the MCP vocabulary, schemas, and
// rendering. One SDK client is retained for each MCP session so binding changes
// and later tool calls share the same live session state.
import { ToolRegistry, type ToolPolicy } from './registry.js';
import { markManagedClient } from './tool.js';
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
  options: { remoteDaemonFiles?: boolean; policy?: ToolPolicy; fileContext?: FileExecutionContext } = {},
): McpServer {
  if (options.policy && !options.fileContext) throw new Error('Managed ours MCP requires an agent file context');
  const server = new McpServer(
    { name: 'ours', version },
    { capabilities: { logging: {} } },
  );

  const provider: OursClientProvider = typeof client === 'function' ? client : () => client;
  const clientFor: OursClientProvider = async extra => {
    const attached = await provider(extra);
    if (options.policy) markManagedClient(attached);
    return attached;
  };
  const registry = new ToolRegistry(server, options.policy);

  registerIdentityTools(registry, clientFor, applicationIdentities, { managedLifetime: Boolean(options.policy) });
  registerContactsTools(registry, clientFor);
  registerProfileTools(registry, clientFor);
  registerMessagingTools(registry, clientFor, options.fileContext);
  registerCommandTools(registry, clientFor);
  registerFilesTools(registry, clientFor, options);
  registerHistoryTools(registry, clientFor);

  return server;
}

export { REGISTRY_VERSION, TOOL_EFFECTS, type ToolEffect, type ToolPolicy } from "./registry.js";
export type { FileExecutionContext } from "./file-context.js";

/** Fixed-identity entry point: lifecycle tools cannot be enabled by a caller policy. */
export function createManagedOursMcpServer(
  client: OursClient,
  version: string,
  applicationIdentities: ApplicationIdentityStore,
  options: {
    fileContext: FileExecutionContext;
    admit: ToolPolicy['admit'];
    remoteDaemonFiles?: boolean;
  },
): McpServer {
  return createOursMcpServer(client, version, applicationIdentities, {
    ...options,
    policy: { version: 1, allowedEffects: ['bound', 'profile', 'contact', 'inventory', 'filesystem'], admit: options.admit },
  });
}
