import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { attachOursClient, OursError, resolveDaemonConfig } from '@ours.network/sdk';
import type { OursClient } from '@ours.network/sdk';

import { ApplicationIdentityStore } from './application-identities.js';
import { hostProfileFromEnv, validateHostProfile } from './host-profile.js';
import type { HostProfile } from './host-profile.js';
import { nativeClientFor } from './native-session.js';
import { createOursMcpServer } from './mcp/server.js';
import { pushArrivalNotification } from './mcp/push.js';
import { getBoundIdentity, rememberBinding } from './mcp/tool.js';
import type { ToolRequestExtra } from './mcp/tool.js';

export type ExternalConnectorSelection = Readonly<{
  mode: 'external-profile';
  profile: HostProfile;
  ownerInstanceId: string;
}>;

export interface ConnectorOptions {
  leaseToken: string;
  clientPid: number;
  version: string;
  bindIdentity?: string;
  selection?: ExternalConnectorSelection;
}

const OBSOLETE_DAEMON_ENV = [
  'OURS_AUTOSTART',
  'OURS_BROKER_URL',
  'OURS_GC_INTERVAL_MS',
  'OURS_SERVICE_NAME',
  'OURS_TRANSPORT',
  'OURS_UNIT_DIR',
] as const;

let stdioFailureHandler: (() => void) | null = null;
const log = (message: string): void => {
  try {
    process.stderr.write(`ours: ${message}\n`, (error) => { if (error) stdioFailureHandler?.(); });
  } catch {
    stdioFailureHandler?.();
  }
};

function rejectObsoleteDaemonEnvironment(env: NodeJS.ProcessEnv): void {
  const found = OBSOLETE_DAEMON_ENV.filter((name) => (env[name] ?? '').trim() !== '');
  if (found.length === 0) return;
  throw new Error(
    `${found.join(', ')} ${found.length === 1 ? 'is' : 'are'} obsolete in ours-mcp. ` +
    'The shared daemon is owned by the `ours` CLI; remove these variables and configure it with `ours config setup`.',
  );
}

export class ArrivalWatcher {
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
        const known = getBoundIdentity(this.client);
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
          pushArrivalNotification(this.server, summary, (what, error) =>
            log(`[${name}] ${what} failed: ${String(error)}`));
          if (getBoundIdentity(this.client) !== name) {
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
  try {
    const existing = await client.currentIdentity();
    rememberBinding(client, existing.name);
    log(`[${existing.name}] existing session binding takes precedence over OURS_BIND_IDENTITY=${JSON.stringify(name)}`);
    return;
  } catch (error) {
    if (!(error instanceof OursError) || error.code !== 'NOT_BOUND') {
      log(`could not inspect the existing session binding; OURS_BIND_IDENTITY was not applied (${String(error)})`);
      return;
    }
  }

  let wasVisible = false;
  try {
    wasVisible = await identities.has(name);
    if (!wasVisible) await identities.add(name);
    const bound = await client.chooseIdentity({ name, force: false });
    rememberBinding(client, bound.name);
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

async function attachConnector(options: ConnectorOptions, env: NodeJS.ProcessEnv = process.env): Promise<{ client: OursClient; endpoint: string; identities: ApplicationIdentityStore }> {
  rejectObsoleteDaemonEnvironment(env);
  if (options.selection !== undefined) {
    const selection = options.selection as ExternalConnectorSelection;
    if (!selection || selection.mode !== 'external-profile') throw new Error('Unknown connector selection mode.');
    if (typeof selection.ownerInstanceId !== 'string' || !selection.ownerInstanceId.trim()) throw new Error('External owner context is required.');
    const profile = validateHostProfile(selection.profile);
    const conflicting = ['OURS_API_TOKEN', 'OURS_PORT', 'OURS_STATE_DIR', 'OURS_DAEMON_ID'].filter((key) => (env[key] ?? '').trim() !== '');
    if (conflicting.length) throw new Error('External host profile conflicts with legacy selection.');
    const identities = new ApplicationIdentityStore({ instanceId: profile.expectedInstanceId });
    await identities.list();
    const client = await attachOursClient({
      endpoint: profile.endpoint,
      expectedInstanceId: profile.expectedInstanceId,
      credentialPath: profile.credentialPath,
      sessionMode: 'external',
      leaseToken: selection.ownerInstanceId,
      env: {},
    });
    return { client, endpoint: profile.endpoint, identities };
  }

  if (hostProfileFromEnv(env) !== null) throw new Error('External owner context is required.');
  const selection = resolveDaemonConfig();
  const identities = new ApplicationIdentityStore(selection.expectStateDir);
  await identities.list();
  const client = await attachOursClient({
    leaseToken: options.leaseToken,
    clientPid: options.clientPid,
  });
  return { client, endpoint: selection.baseUrl.value, identities };
}

export async function runConnector(options: ConnectorOptions): Promise<void> {
  let client: OursClient | undefined;
  let identities: ApplicationIdentityStore;
  let endpoint: string;
  const nativeProfile = options.selection === undefined ? hostProfileFromEnv(process.env) : null;
  try {
    if (nativeProfile) {
      identities = new ApplicationIdentityStore({ instanceId: nativeProfile.expectedInstanceId });
      await identities.list();
      endpoint = nativeProfile.endpoint;
    } else {
      const attached = await attachConnector(options, process.env);
      client = attached.client;
      endpoint = attached.endpoint;
      identities = attached.identities;
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log(reason);
    await refuseOverStdio(reason, options.version);
    return;
  }

  const seed = (options.bindIdentity ?? '').trim();
  if (seed && client) await seedBinding(client, identities, seed);

  let server!: ReturnType<typeof createOursMcpServer>;
  const watchers = new Set<ArrivalWatcher>();
  const nativeWatchers = new Map<string, { client: OursClient; watcher: ArrivalWatcher }>();
  const seeded = new WeakSet<OursClient>();
  const nativeSelector = (extra: ToolRequestExtra): string => {
    const metadata = extra._meta as Record<string, unknown> | undefined;
    if (metadata && Object.hasOwn(metadata, 'threadId')) {
      if (typeof metadata.threadId !== 'string') throw new Error('Native session metadata is missing or invalid for this host-profile tool call.');
      return metadata.threadId;
    }
    const claude = (process.env.CLAUDE_CODE_SESSION_ID ?? '').trim();
    if (!claude) throw new Error('Native session metadata is missing or invalid for this host-profile tool call.');
    return claude;
  };
  const clientFor = nativeProfile
    ? async (extra: ToolRequestExtra): Promise<OursClient> => {
        const selector = nativeSelector(extra);
        const selected = await nativeClientFor(nativeProfile, selector, process.env);
        if (seed && !seeded.has(selected)) {
          await seedBinding(selected, identities, seed);
          seeded.add(selected);
        }
        const existing = nativeWatchers.get(selector);
        if (existing?.client !== selected) {
          existing?.watcher.stop();
          if (existing) watchers.delete(existing.watcher);
          const watcher = new ArrivalWatcher(selected, server);
          nativeWatchers.set(selector, { client: selected, watcher });
          watchers.add(watcher);
          void watcher.run();
        }
        return selected;
      }
    : client!;

  server = createOursMcpServer(clientFor, options.version, identities);
  if (client) {
    const watcher = new ArrivalWatcher(client, server);
    watchers.add(watcher);
    void watcher.run();
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`MCP server v${options.version} ready (transport=stdio, daemon=${endpoint})`);

  let stdioBroken: (() => void) | undefined;
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = (reason: string): void => {
      if (done) return;
      done = true;
      log(`shutting down (${reason})`);
      resolve();
    };
    stdioBroken = () => finish('stdio output closed');
    stdioFailureHandler = stdioBroken;
    process.stdin.on('end', () => finish('stdin closed'));
    process.stdin.on('close', () => finish('stdin closed'));
    process.stdout.once('error', stdioBroken);
    process.stderr.once('error', stdioBroken);
    process.stdout.once('close', stdioBroken);
    process.stderr.once('close', stdioBroken);
    process.on('SIGINT', () => finish('SIGINT'));
    process.on('SIGTERM', () => finish('SIGTERM'));
  });

  if (stdioBroken) {
    process.stdout.off('error', stdioBroken);
    process.stderr.off('error', stdioBroken);
    process.stdout.off('close', stdioBroken);
    process.stderr.off('close', stdioBroken);
  }
  stdioFailureHandler = null;
  for (const watcher of watchers) watcher.stop();
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
