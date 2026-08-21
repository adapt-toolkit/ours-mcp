// The ours MCP server: agent-facing adapters over
// `@ours.network/sdk`.
//
// ============================================================================
// WHAT THIS FILE REPLACED, AND WHY IT IS SHORT
// ============================================================================
// `index.ts`'s `createMcpServer` was ~2000 lines: every tool handler carried its
// own engine work — `withScopeAsync`, `mutatingTx`, `identities.get`, and a
// hand-written error string per failure. All of it now lives in the SDK, so what
// is left here is what ours-mcp is actually for: the MCP vocabulary. Tool names,
// descriptions, zod schemas, and the rendering of typed facts into prose.
//
// The registrars are grouped exactly as the SDK's `src/api/*` modules are —
// identity, contacts, profile, messaging, files — so a tool and the operation
// behind it are one import apart.
//
// No monitoring tools: they were removed with the daemon-side control plane
// (ours-sdk 0b84122) and the owner has ruled they stay out. A DEFERRAL, not a
// deletion of the capability — pairing a messenger to a machine has no route
// after this, and re-adding it needs an authorization rule that does not exist.
//
// The connector owns one SDK client for one MCP session. Registrars receive a
// thunk so binding-changing operations and later tool calls always use that same
// live client rather than capturing daemon-side state locally.
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
