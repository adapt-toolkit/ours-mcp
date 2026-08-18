// The ours daemon entry point.
//
// ============================================================================
// THE DAEMON NO LONGER HOSTS AN MCP SERVER. THAT IS THE POINT OF THIS FILE NOW.
// ============================================================================
// It used to inject an `mcp` integration into the SDK's `startDaemon` — a server
// factory, a transport constructor, session-initialized/closed hooks, and a
// notification sink that pushed `sendResourceUpdated` at whichever MCP session
// held the identity. That injection is what made the SDK mount `/mcp` at all.
//
// The owner's rule is that there is exactly ONE MCP server in the system: the
// stdio server ours-mcp presents to the harness (see ./connector.ts). Everything
// else — that server, the CLI, the SDK — is a client of the daemon's HTTP API.
// So the injection is gone, and with it:
//
//   * `serversBySession`, and the whole per-session MCP server registry;
//   * `pushNotification`'s resource-update fan-out, which had no session to aim
//     at once the sessions stopped existing (the connector now watches
//     `/identities/<name>/notifications` and emits the update itself);
//   * `createHttpServerTransport` / `isInitializeRequest`, which existed only to
//     hand the SDK an MCP transport it may not import for itself.
//
// The SDK's `startDaemon` 404s `/mcp` whenever nothing is injected, so passing no
// `mcp` option is all it takes for the route to stop existing. Deleting the seam
// from the SDK is a separate, behaviour-neutral change in that repo — it cannot
// be part of this commit, because ours-mcp consumes a PUBLISHED SDK by version
// pin and there is no cross-repo atomic merge.
//
// ----- WHAT IS LEFT ---------------------------------------------------------
// One thing only: start the SDK daemon with ours-mcp's version, so the startup
// line announces the release an operator installed rather than the SDK's own
// number, and keep the operator-visible arrival line in the daemon log.
import { startDaemon } from '@ours.network/sdk/daemon';
import type { DaemonHandle } from '@ours.network/sdk/daemon';

export async function serve(version: string): Promise<DaemonHandle> {
  return startDaemon({
    version,
    // NO `mcp` OPTION. See the header — this absence is the change.
    //
    // Kept as a LOG-ONLY sink. It used to fan an inbox resource update out to the
    // MCP session holding the identity; there are no such sessions any more, and
    // the connector learns about arrivals from the notifications endpoint. What
    // would have been lost with it is the operator-visible line in the daemon log
    // saying mail arrived, which is worth one function on its own.
    onIdentityNotify: (identityName, summary) => {
      try { process.stderr.write(`ours: [${identityName}] notify: ${summary}\n`); } catch { /* no reader */ }
    },
  });
}
