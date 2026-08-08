// The MCP transports, supplied to the SDK connector and daemon.
//
// ============================================================================
// WHY THIS FILE EXISTS: THE DEPENDENCY DIRECTION IS ONE-WAY
// ============================================================================
// `@ours.network/sdk` must not depend on `@modelcontextprotocol/sdk` — or on
// `zod`, which it drags in. Two independent gates in ours-sdk enforce that
// (`test/wire-handlers-integrity.test.mjs` on the imports,
// `test/dist-shared-state.test.mjs` on the bundle graph), because a peer
// dependency failed in BOTH directions: marked `external`, esbuild inlines the
// whole MCP SDK and zod into `dist/daemon.js`; not external, resolution breaks at
// a consumer's runtime under the shared npm-cache layout that
// `packages/claude-code/bin/proxy.mjs:1-12` documents.
//
// So the SDK never writes `new StreamableHTTPClientTransport(...)`. It keeps the
// construction ARGUMENTS — every one of them, including the reconnection tuning
// that DEFECT B was fixed with — and takes the `new` from here. ours-mcp is the
// only side that imports the MCP package, which is correct: ours-mcp is the MCP
// server. That is the whole of the deviation.
//
// Note what is NOT in this file: no retry policy, no header names, no timeouts.
// If a value appears below that is not a type cast, something has leaked back
// out of the SDK and should be pushed down into it.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import type { TransportFactories } from '@ours.network/sdk/connector';

/**
 * For `runProxy`. `HttpClientTransportInit` is shaped so `init` passes straight
 * into the real transport — the SDK decides the reconnection budget and the
 * lease headers, this only constructs.
 */
export const connectorTransports: TransportFactories = {
  createStdioServer: () => new StdioServerTransport() as unknown as ReturnType<TransportFactories['createStdioServer']>,
  createHttpClient: (url, init) =>
    new StreamableHTTPClientTransport(url, init) as unknown as ReturnType<TransportFactories['createHttpClient']>,
};

/**
 * For `startDaemon`. The daemon side needs the SERVER transport plus the
 * initialize-request predicate; the SDK ships a zod-free structural default for
 * the latter, but the real one is authoritative and we have it here.
 */
export const createHttpServerTransport = (
  init: ConstructorParameters<typeof StreamableHTTPServerTransport>[0],
): StreamableHTTPServerTransport => new StreamableHTTPServerTransport(init);

export { isInitializeRequest };
