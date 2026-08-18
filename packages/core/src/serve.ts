// The ours daemon entry point. It NO LONGER INJECTS AN MCP SERVER, which is what
// made the SDK mount /mcp; passing no `mcp` option is all it takes for the route
// to stop existing. The stdio server is ./connector.ts, a separate process.
//
// Deleting the seam from the SDK is a separate change in that repo — ours-mcp
// consumes a published SDK by version pin, so there is no atomic cross-repo merge.
import { startDaemon } from '@ours.network/sdk/daemon';
import type { DaemonHandle } from '@ours.network/sdk/daemon';

export async function serve(version: string): Promise<DaemonHandle> {
  return startDaemon({
    version,
    // Log-only sink: there are no MCP sessions to fan a resource update at, and the
    // connector learns of arrivals from the notifications endpoint. This keeps the
    // operator-visible arrival line in the daemon log.
    onIdentityNotify: (identityName, summary) => {
      try { process.stderr.write(`ours: [${identityName}] notify: ${summary}\n`); } catch { /* no reader */ }
    },
  });
}
