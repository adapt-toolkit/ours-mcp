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
import type { DaemonHandle, McpServerLike, McpTransportInit, McpTransportLike } from '@ours.network/sdk/daemon';
// SessionContext is on the root barrel, not ./daemon — the daemon entry re-exports
// the daemon surface, the typed API surface lives at '.'.
import type { SessionContext } from '@ours.network/sdk';

import { loadConfig } from './config';
import { createHttpServerTransport, isInitializeRequest } from './mcp/transports.js';
import { pushInboxNotifications } from './mcp/push.js';
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
  // WHY THE OUTCOME IS LOGGED AND NOT JUST THE SUMMARY. Both `return`s below are
  // silent drops on the happy path's own route, and the line above prints
  // identically whether the update reached a client or went nowhere — which is
  // exactly how a broken resource-update path can look healthy in a log for
  // months. test/resource-updated.test.mjs proves the delivery end to end; this
  // is what makes a live failure legible without a debugger.
  if (!boundSessionId) {
    process.stderr.write(`ours: [${identityName}] no bound session — no resource update sent\n`);
    return;
  }
  const server = serversBySession.get(boundSessionId);
  if (!server) {
    process.stderr.write(`ours: [${identityName}] session ${boundSessionId.slice(0, 8)}… has no MCP server registered — no resource update sent\n`);
    return;
  }
  // BOTH pushes, in the baseline's order (index.ts:2168-2176), and both made
  // best-effort against a synchronous throw AND an asynchronous rejection. What
  // used to stand here sent only the resource update, inside a try/catch that
  // could not see a rejection anyway — see the header of ./mcp/push.ts for why
  // each half was invisible on its own.
  pushInboxNotifications(server, inboxResourceUri(identityName), summary, (what, err) => {
    process.stderr.write(`ours: [${identityName}] ${what} failed: ${String(err)}\n`);
  });
}

export async function serve(version: string): Promise<DaemonHandle> {
  return startDaemon({
    // Without this the daemon's startup line announces the SDK's version rather
    // than the ours-mcp release the operator installed.
    version,
    mcp: {
      // NOTE THE SHAPE OF WHAT WAS HERE, because it looked right and was dead.
      // This used to end with `const sid = ctx.sessionId(); if (sid && sid !==
      // 'pending') serversBySession.set(sid, server)`. createServer runs BEFORE
      // the initialize response, so ctx.sessionId() ALWAYS answers 'pending'
      // here and the guard was always false: the map stayed empty for the whole
      // life of the daemon and no inbox resource update ever reached an HTTP
      // client. Nothing errored — pushNotification's log line reads the same on
      // the way to a client and on the way to nowhere.
      // The registration now happens in onSessionInitialized, which is the
      // moment the id exists. test/resource-updated.test.mjs is what caught it
      // and is what keeps it caught.
      createServer: (ctx: SessionContext) => createOursMcpServer(ctx, version),
      onSessionInitialized: (sid: string, server: McpServerLike) => {
        // The cast is sound and narrow: this is the very server createServer
        // returned one step earlier, handed back by the SDK precisely so the
        // host does not have to guess which session it belonged to.
        serversBySession.set(sid, server as ReturnType<typeof createOursMcpServer>);
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
 *
 * ⚠ THIS PATH HAS NO DAEMON LIFECYCLE, AND THAT IS A KNOWN GAP, NOT AN OVERSIGHT.
 * `bootWrapper()` starts the engine and nothing else: the notify hook, the
 * message GC timer with the contact-restore / capability-reconcile / e2e-recovery
 * sweeps, and the SIGINT/SIGTERM handler that saves every identity's state all
 * live INSIDE the SDK's `startDaemon`, which is the HTTP daemon. Baseline
 * `index.ts:5157-5182` armed the GC timer and the signal flush here, and its
 * `pushNotification` was module-level so stdio got inbox pushes too; none of that
 * survives the split. Tracked at adapt-toolkit/ours-sdk#18.
 *
 * NOT partially restored on purpose. The notify half alone IS reachable from
 * here (`setDaemonEventHandler('notification', …)` is on the SDK's root barrel),
 * but the GC arm is NOT — the SDK's exports map has three entries and no
 * wildcard, so `@ours.network/sdk/gc` cannot be imported at all. Wiring the one
 * reachable half would make this path look like it had lifecycle parity while
 * the sweeps and the shutdown save stayed missing, which is a worse failure than
 * an absence you can read about here.
 *
 * Non-blocking today because stdio is dev-only: `npm run dev:stdio` is its only
 * caller, no test drives it, and `.mcp.json` and all three plugins launch
 * `dist/cli.js proxy` (HTTP). Anything that makes stdio a shipped surface has to
 * close the gap first.
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
