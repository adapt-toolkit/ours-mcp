// One place that knows how a test talks to ours-mcp's tools.
//
// ============================================================================
// WHY THIS EXISTS, AND WHY IT IS BETTER THAN WHAT IT REPLACED
// ============================================================================
// Twelve tests used to open an MCP `Client` on a `StreamableHTTPClientTransport`
// pointed at the daemon's `/mcp`. That endpoint is gone: the daemon does not host
// an MCP server any more, and the only MCP server in the system is the stdio one
// ours-mcp presents to the harness.
//
// So a test now spawns THE REAL SHIPPED CONNECTOR (`dist/cli.js proxy`) over
// stdio. Every `callTool(name, args)` line in those tests is unchanged — only the
// transport construction moved here — and the coverage is strictly better,
// because the path under test is the one users actually run rather than an
// endpoint that existed for the proxy's benefit.
//
// ----- THE LEASE TOKEN IS THE SESSION, AND TESTS MUST SAY WHICH ONE ---------
// The daemon derives its API session from a hash of `x-ours-lease-token`, and the
// lease table is keyed by that token. So two connectors sharing a token share a
// binding, and two with different tokens are two sessions — which is exactly what
// the binding tests need to express. `CLAUDE_CODE_SESSION_ID` is what the
// connector reads, so that is what this sets.
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const CLI = join(HERE, '..', '..', 'dist', 'cli.js');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait for a daemon on `port` to answer /version, or throw. */
export async function waitForDaemon(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/version`)).ok) return true;
    } catch { /* not yet */ }
    await sleep(150);
  }
  throw new Error(`daemon on port ${port} never became ready`);
}

/** Spawn the ours daemon (`dist/cli.js serve`) on `port` against `stateDir`. */
export function spawnDaemon(port, stateDir, extraEnv = {}) {
  return spawn('node', [CLI, 'serve'], {
    env: {
      ...process.env,
      OURS_TRANSPORT: 'http',
      OURS_PORT: String(port),
      OURS_STATE_DIR: stateDir,
      OURS_BROKER_URL: 'wss://invalid.local/none',
      OURS_API_VISIBILITY: 'open',
      OURS_GC_INTERVAL_MS: '3600000',
      ...extraEnv,
    },
    stdio: 'ignore',
  });
}

/**
 * Connect an MCP client to a freshly spawned connector.
 *
 * Returns `{ client, call, txt, close }`. `close()` shuts the connector's stdin,
 * which is the ONLY way it learns to exit — its transport's `onclose` never fires
 * (StdioServerTransport registers just 'data' and 'error' on stdin), which is the
 * whole reason src/connector.ts listens on `process.stdin` directly.
 */
export async function connectConnector({ port, stateDir, leaseToken, clientPid, env = {} }) {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [CLI, 'proxy'],
    env: {
      ...process.env,
      OURS_PORT: String(port),
      OURS_STATE_DIR: stateDir,
      OURS_BROKER_URL: 'wss://invalid.local/none',
      OURS_API_VISIBILITY: 'open',
      ...(leaseToken ? { CLAUDE_CODE_SESSION_ID: leaseToken } : {}),
      // The connector reads this as the CLIENT's pid (the harness, not itself).
      // Tests that exercise the dead-pid lease reclaim need to choose it.
      ...(clientPid !== undefined ? { OURS_CLIENT_PID: String(clientPid) } : {}),
      ...env,
    },
    // The connector's diagnostics are on stderr; surface them so a failing test
    // shows the reason instead of an unexplained timeout.
    stderr: 'inherit',
  });
  const client = new Client({ name: 'ours-test', version: '0.0.0' });
  await client.connect(transport);

  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  const txt = (r) => (Array.isArray(r.content) ? r.content : [])
    .map((c) => (typeof c.text === 'string' ? c.text : ''))
    .join('\n');

  return {
    client,
    transport,
    call,
    txt,
    close: async () => { try { await client.close(); } catch { /* already gone */ } },
  };
}
