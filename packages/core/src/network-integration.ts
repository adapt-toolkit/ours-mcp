import { resolve } from 'node:path';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { attachOursClient } from '@ours.network/sdk';
import type { OursClient } from '@ours.network/sdk';

import { ApplicationIdentityStore } from './application-identities.js';
import { ArrivalWatcher } from './connector.js';
import { validateHostProfile } from './host-profile.js';
import type { HostProfile } from './host-profile.js';
import { createOursMcpServer } from './mcp/server.js';

declare const __OURS_VERSION__: string;
const VERSION = typeof __OURS_VERSION__ === 'undefined' ? '0.0.0-dev' : __OURS_VERSION__;

type SessionContext = Readonly<{
  leaseToken(): string | undefined;
  sessionMode(): 'external' | 'local';
}>;

type SessionState = {
  context: SessionContext;
  server: ReturnType<typeof createOursMcpServer>;
  sessionId?: string;
  client?: Promise<OursClient>;
  watcher?: ArrivalWatcher;
  closed: boolean;
};

export type NetworkMcpOptions = Readonly<{
  profile: HostProfile;
  applicationConfigPath: string;
}>;

/** Compose the packaged ours tools into the SDK daemon's existing `/mcp` listener. */
export function createNetworkMcpIntegration(options: NetworkMcpOptions) {
  const profile = validateHostProfile(options?.profile);
  if (typeof options?.applicationConfigPath !== 'string' || options.applicationConfigPath === '' ||
      !options.applicationConfigPath.startsWith('/') || resolve(options.applicationConfigPath) !== options.applicationConfigPath) {
    throw new Error('Network MCP applicationConfigPath must be a normalized absolute path.');
  }
  const identities = new ApplicationIdentityStore(
    { instanceId: profile.expectedInstanceId },
    { path: options.applicationConfigPath },
  );
  // Before initialization the SDK has no session ID and therefore no close
  // callback key. Keep that server lookup weak so an abandoned initialize does
  // not retain its server and handler graph for the daemon's lifetime.
  const states = new WeakMap<ReturnType<typeof createOursMcpServer>, SessionState>();
  const sessions = new Map<string, SessionState>();

  const activateWatcher = (state: SessionState): void => {
    if (state.closed || !state.sessionId || !state.client || state.watcher) return;
    void state.client.then((client) => {
      if (state.closed || state.watcher) return;
      const watcher = new ArrivalWatcher(client, state.server);
      state.watcher = watcher;
      void watcher.run();
    }).catch((error) => {
      process.stderr.write(`ours: network MCP notification attachment failed: ${String(error)}\n`);
    });
  };

  return {
    createServer(context: SessionContext) {
      let state!: SessionState;
      const clientFor = (): Promise<OursClient> => {
        if (context.sessionMode() !== 'external') {
          throw new Error('Network MCP requires external session mode.');
        }
        const owner = context.leaseToken();
        if (!owner) throw new Error('Network MCP requires an external owner.');
        if (!state.client) {
          state.client = attachOursClient({
            ...profile,
            sessionMode: 'external',
            leaseToken: owner,
            env: {},
          });
        }
        activateWatcher(state);
        return state.client;
      };
      const server = createOursMcpServer(clientFor, VERSION, identities, { networkHostFiles: true });
      state = { context, server, closed: false };
      states.set(server, state);
      return server;
    },
    createTransport(init: { sessionIdGenerator(): string; onsessioninitialized(sessionId: string): void }) {
      return new StreamableHTTPServerTransport(init);
    },
    isInitializeRequest,
    onSessionInitialized(sessionId: string, server: ReturnType<typeof createOursMcpServer>) {
      const state = states.get(server);
      if (!state) throw new Error('Network MCP initialized an unknown server.');
      state.sessionId = sessionId;
      sessions.set(sessionId, state);
      activateWatcher(state);
    },
    onSessionClosed(sessionId: string) {
      const state = sessions.get(sessionId);
      if (!state) return;
      sessions.delete(sessionId);
      states.delete(state.server);
      state.closed = true;
      state.watcher?.stop();
      void state.client?.then((client) => client.close()).catch(() => {});
    },
  };
}
