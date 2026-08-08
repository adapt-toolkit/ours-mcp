// The ours daemon entry point.
//
// ============================================================================
// WHAT THIS REPLACED
// ============================================================================
// `index.ts`'s `main()` plus ~400 lines of HTTP route table, session reaper,
// request-meta bookkeeping and shutdown handling. All of that is now
// `startDaemon()` in `@ours.network/sdk/daemon`, byte-for-byte the same code —
// it was MOVED there, not rewritten. What is left is the three things only
// ours-mcp can supply:
//
//   1. the MCP server factory        (our 32 tools and one resource)
//   2. the MCP transport constructor (the SDK must not import the MCP package)
//   3. the notification sink         (`sendResourceUpdated` on our own servers)
//
// The stdio branch did NOT move and stays here: `startDaemon` is the HTTP daemon,
// and a single stdio session is ours-mcp's own front door.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { listIdentities } from '@ours.network/sdk';
import { bootWrapper, startDaemon } from '@ours.network/sdk/daemon';
import type { DaemonHandle, McpTransportInit, McpTransportLike } from '@ours.network/sdk/daemon';
// SessionContext is on the root barrel, not ./daemon — the daemon entry re-exports
// the daemon surface, the typed API surface lives at '.'.
import type { SessionContext } from '@ours.network/sdk';

import { loadConfig } from './config';
import { createHttpServerTransport, isInitializeRequest } from './mcp/transports.js';
import { createOursMcpServer } from './mcp/server.js';

const CONFIG = loadConfig();
// ONE definition of the inbox uri, imported rather than repeated: this and the
// resource handler must agree exactly or a client subscribes to a uri nothing
// updates. index.ts:2160 held the only other copy and it is going.
import { inboxResourceUri } from './mcp/resources/inbox.js';

/**
 * Every live MCP server, by session id. The SDK does not know about this map —
 * it is ours because `pushNotification` needs to reach a specific session's
 * server — so `startDaemon` tells us when a session dies via `onSessionClosed`
 * and we drop it in step. Without that hook this map is a leak on connection
 * churn, each entry retaining a whole McpServer's zod tool-schema bindings.
 */
const serversBySession = new Map<string, ReturnType<typeof createOursMcpServer>>();

/**
 * Announce new mail on the bound session's inbox resource. The third argument is
 * resolved by the SDK WHEN THE CALLBACK FIRES, not when the hook is installed,
 * so a rebind between arrival and delivery targets the session that holds the
 * identity now.
 */
function pushNotification(identityName: string, summary: string, boundSessionId: string | null): void {
  process.stderr.write(`ours: [${identityName}] notify: ${summary}\n`);
  if (!boundSessionId) return;
  const server = serversBySession.get(boundSessionId);
  if (!server) return;
  // Best-effort: a client that has gone away must not turn an inbound message
  // into an unhandled rejection in the daemon.
  try {
    void server.server.sendResourceUpdated({ uri: inboxResourceUri(identityName) });
  } catch {
    /* the session is going away; the reaper will collect it */
  }
}

export async function serve(version: string): Promise<DaemonHandle> {
  return startDaemon({
    // Without this the daemon's startup line announces the SDK's version rather
    // than the ours-mcp release the operator installed.
    version,
    mcp: {
      createServer: (ctx: SessionContext) => {
        const server = createOursMcpServer(ctx, version);
        // The SDK registers the session id -> server association for its own
        // bookkeeping; this keeps OURS in step for notifications. It is keyed
        // lazily because the session id does not exist until initialize lands.
        const sid = ctx.sessionId();
        if (sid && sid !== 'pending') serversBySession.set(sid, server);
        return server;
      },
      createTransport: (init: McpTransportInit): McpTransportLike =>
        // The SDK owns the construction ARGUMENTS (session id generation, the
        // initialized callback that registers the session); only the `new` is
        // ours, because the SDK may not import @modelcontextprotocol/sdk.
        createHttpServerTransport(init) as unknown as McpTransportLike,
      // The real predicate rather than the SDK's zod-free structural stand-in:
      // we have the MCP package, so the two sides cannot drift.
      isInitializeRequest,
      onSessionClosed: (sid: string) => {
        serversBySession.delete(sid);
      },
    },
    onIdentityNotify: pushNotification,
  });
}

/**
 * The stdio front door. One fixed session id, transport connected BEFORE the
 * wrapper boots so the initialize handshake does not time out while identities
 * load — unchanged from `index.ts:5158-5181`.
 */
export async function serveStdio(version: string): Promise<void> {
  const ctx: SessionContext = {
    sessionId: () => 'stdio',
    leaseToken: () => 'stdio-local',
    clientPid: () => process.pid,
  };
  const server = createOursMcpServer(ctx, version);
  serversBySession.set('stdio', server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('ours: MCP stdio transport connected, booting wrapper…\n');

  await bootWrapper();
  // The baseline's line, restored in full (index.ts:5171). The truncated version
  // I first wrote dropped identities/state/broker — all three are what an
  // operator reads to confirm WHICH daemon came up, and the ux-strings run
  // against the integrated trees is what caught the loss.
  const ids = await listIdentities({
    sessionId: () => 'stdio', leaseToken: () => 'stdio-local', clientPid: () => process.pid,
  });
  process.stderr.write(
    `ours: MCP server v${version} ready (transport=stdio, identities=${ids.length}, ` +
    `state=${CONFIG.stateDir}, broker=${CONFIG.brokerUrl})\n`,
  );
}
