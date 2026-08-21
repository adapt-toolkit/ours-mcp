import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { attachOursClient, resolveDaemonConfig } from '@ours.network/sdk';
import type { OursClient } from '@ours.network/sdk';

import { ApplicationIdentityStore } from './application-identities.js';
import { createOursMcpServer } from './mcp/server.js';
import { pushInboxNotifications } from './mcp/push.js';
import { inboxResourceUri } from './mcp/resources/inbox.js';
import { getBoundIdentity, rememberBinding } from './mcp/tool.js';

export interface ConnectorOptions {
  leaseToken: string;
  clientPid: number;
  version: string;
  bindIdentity?: string;
}

const OBSOLETE_DAEMON_ENV = [
  'OURS_AUTOSTART',
  'OURS_BROKER_URL',
  'OURS_GC_INTERVAL_MS',
  'OURS_SERVICE_NAME',
  'OURS_TRANSPORT',
  'OURS_UNIT_DIR',
] as const;

const log = (message: string): void => {
  try { process.stderr.write(`ours: ${message}\n`); } catch { /* reader gone */ }
};

function rejectObsoleteDaemonEnvironment(env: NodeJS.ProcessEnv): void {
  const found = OBSOLETE_DAEMON_ENV.filter((name) => (env[name] ?? '').trim() !== '');
  if (found.length === 0) return;
  throw new Error(
    `${found.join(', ')} ${found.length === 1 ? 'is' : 'are'} obsolete in ours-mcp. ` +
    'The shared daemon is owned by the `ours` CLI; remove these variables and configure it with `ours config setup`.',
  );
}

export class InboxWatcher {
  private stopped = false;
  private bound: string | null = null;
  private readonly abort = new AbortController();

  constructor(
    private readonly client: OursClient,
    private readonly server: ReturnType<typeof createOursMcpServer>,
  ) {}

  stop(): void {
    this.stopped = true;
    this.abort.abort();
  }

  async run(): Promise<void> {
    while (!this.stopped) {
      if (this.bound === null) {
        const known = getBoundIdentity();
        if (known === null) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          continue;
        }
        this.bound = known;
        log(`[${known}] watching for arrivals`);
      }

      const name = this.bound;
      try {
        for await (const event of this.client.watchNotifications(name, {
          kinds: ['inbound'],
          signal: this.abort.signal,
        })) {
          if (this.stopped) return;
          const value = event as unknown as { event?: string; from?: string; filename?: string };
          const summary = value.event === 'file_received'
            ? `new file ${value.filename ?? '?'} from ${value.from ?? '?'}`
            : `new message from ${value.from ?? '?'}`;
          pushInboxNotifications(this.server, inboxResourceUri(name), summary, (what, error) =>
            log(`[${name}] ${what} failed: ${String(error)}`));
          if (getBoundIdentity() !== name) {
            this.bound = null;
            break;
          }
        }
      } catch (error) {
        if (this.stopped) return;
        log(`[${name}] arrival watch stopped (${String(error)}) — tool calls still work; retrying`);
        this.bound = null;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }
}

async function seedBinding(
  client: OursClient,
  identities: ApplicationIdentityStore,
  name: string,
): Promise<void> {
  let wasVisible = false;
  try {
    wasVisible = await identities.has(name);
    if (!wasVisible) await identities.add(name);
    const bound = await client.chooseIdentity({ name, force: false });
    rememberBinding(bound.name);
    log(`[${bound.name}] bound from OURS_BIND_IDENTITY and adopted by ours-mcp`);
  } catch (error) {
    if (!wasVisible) {
      try { await identities.remove(name); } catch (rollbackError) {
        log(`could not roll back OURS_BIND_IDENTITY adoption for ${JSON.stringify(name)}: ${String(rollbackError)}`);
      }
    }
    log(
      `OURS_BIND_IDENTITY=${JSON.stringify(name)}: not bound ` +
      `(${error instanceof Error ? error.message : String(error)}) — this session starts UNBOUND.`,
    );
  }
}

export async function runConnector(options: ConnectorOptions): Promise<void> {
  let client: OursClient;
  let identities: ApplicationIdentityStore;
  let endpoint: string;
  try {
    rejectObsoleteDaemonEnvironment(process.env);
    const selection = resolveDaemonConfig();
    endpoint = selection.baseUrl.value;
    identities = new ApplicationIdentityStore(selection.expectStateDir);
    // Validate the application registry before accepting an MCP frame. Unknown
    // schemas and unreadable files are configuration errors, never empty lists.
    await identities.list();
    client = await attachOursClient({
      leaseToken: options.leaseToken,
      clientPid: options.clientPid,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log(reason);
    await refuseOverStdio(reason, options.version);
    return;
  }

  const seed = (options.bindIdentity ?? '').trim();
  if (seed) await seedBinding(client, identities, seed);

  const server = createOursMcpServer(client, options.version, identities);
  const watcher = new InboxWatcher(client, server);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`MCP server v${options.version} ready (transport=stdio, daemon=${endpoint})`);
  void watcher.run();

  await new Promise<void>((resolve) => {
    let done = false;
    const finish = (reason: string): void => {
      if (done) return;
      done = true;
      log(`shutting down (${reason})`);
      resolve();
    };
    process.stdin.on('end', () => finish('stdin closed'));
    process.stdin.on('close', () => finish('stdin closed'));
    process.on('SIGINT', () => finish('SIGINT'));
    process.on('SIGTERM', () => finish('SIGTERM'));
  });

  watcher.stop();
  try { await transport.close(); } catch { /* already closed */ }
}

async function refuseOverStdio(reason: string, version: string): Promise<void> {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const server = new McpServer(
    { name: 'ours', version },
    { capabilities: {}, instructions: `ours is NOT AVAILABLE this session: ${reason}` },
  );
  const transport = new StdioServerTransport();
  await server.connect(transport);
  server.server.onerror = () => { /* refusal is already in instructions */ };
  await new Promise<void>((resolve) => {
    process.stdin.on('end', resolve);
    process.stdin.on('close', resolve);
    process.on('SIGINT', resolve);
    process.on('SIGTERM', resolve);
  });
  try { await transport.close(); } catch { /* already closed */ }
}
