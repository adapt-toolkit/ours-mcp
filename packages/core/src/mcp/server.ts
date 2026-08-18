// The ours MCP server: 32 tools and one resource, all of them adapters over
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
// ----- WHY `ctx` IS PASSED AS A THUNK -------------------------------------
// `startDaemon` hands us a `SessionContext` whose three members are GETTERS
// (`sdk src/http/server.ts:558-562`): the transport has no session id until the
// initialize response lands, and the request headers change on every call. The
// registrars therefore take `() => SessionContext` and call it fresh inside each
// handler. Nothing may hoist `ctx.leaseToken()` into a local — an operation that
// rebinds mid-call (choose_identity, create_identity) must observe the lease
// table as it is NOW.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { OursClient } from '@ours.network/sdk';

import { registerInboxResource } from './resources/inbox.js';
import { registerContactsTools } from './tools/contacts.js';
import { registerFilesTools } from './tools/files.js';
import { registerIdentityTools } from './tools/identity.js';
import { registerMessagingTools } from './tools/messaging.js';
import { registerProfileTools } from './tools/profile.js';

/**
 * Build the per-session MCP server. Handed to `startDaemon` as
 * `mcp.createServer`, and called once per MCP session.
 */
export function createOursMcpServer(client: OursClient, version: string): McpServer {
  const server = new McpServer(
    { name: 'ours', version },
    { capabilities: { logging: {}, resources: {} } },
  );

  const clientFor = () => client;

  registerIdentityTools(server, clientFor);
  registerContactsTools(server, clientFor);
  registerProfileTools(server, clientFor);
  registerMessagingTools(server, clientFor);
  registerFilesTools(server, clientFor);

  // The one registration that is not a tool: `ours://inbox` (was
  // index.ts:4094-4107). Both developers flagged it as belonging to no
  // registrar, correctly — it is a RESOURCE, and its body did engine work
  // directly. Left behind when index.ts was gutted it would have gone on reading
  // the OLD engine, a live seam in the one place that is not a tool. It is a
  // seventh registrar for exactly the same reason as the other six.
  registerInboxResource(server, clientFor);

  return server;
}
