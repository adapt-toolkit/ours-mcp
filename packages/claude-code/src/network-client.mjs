import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  createMcpNetworkSession as createSharedMcpNetworkSession,
  createNetworkBridge as createSharedNetworkBridge,
  networkFetchForOwner,
  runNetworkProxy as runSharedNetworkProxy,
} from '../../codex/src/network-proxy.mjs';
import {
  endNativeSessionAtRoot,
  hostProfileFromEnv,
  nativeClientForAtRoot,
  nativeSessionRecordPath,
} from '../../core/src/host-client/index.ts';

const CLAUDE_SELECTOR = '__claude_session__';

export function createNetworkBridge({ sessionFactory, send }) {
  return createSharedNetworkBridge({
    sessionFactory: (_selector, options) => sessionFactory(options),
    send,
    selectorFor: () => CLAUDE_SELECTOR,
  });
}

export async function createMcpNetworkSession(options) {
  return createSharedMcpNetworkSession({
    ...options,
    clientInfo: { name: 'ours-claude-code', version: '2.0.0' },
  });
}

async function ownerFor(profile, nativeSessionId, hostRecordRoot) {
  const path = nativeSessionRecordPath(hostRecordRoot, profile.expectedInstanceId, nativeSessionId);
  const record = JSON.parse(readFileSync(path, 'utf8'));
  if (record?.state !== 'active' || typeof record.ownerInstanceId !== 'string') {
    throw new Error(`Native session record at ${path} is not active.`);
  }
  return record.ownerInstanceId;
}

export function createClaudeSessionFactory({
  profile,
  nativeSessionId,
  hostRecordRoot,
  send,
  nativeClientForImpl = nativeClientForAtRoot,
  ownerForImpl = ownerFor,
  createSessionImpl = createMcpNetworkSession,
}) {
  return async ({ onClose } = {}) => {
    const fileClient = await nativeClientForImpl(profile, nativeSessionId, hostRecordRoot);
    const ownerInstanceId = await ownerForImpl(profile, nativeSessionId, hostRecordRoot);
    return createSessionImpl({ profile, ownerInstanceId, fileClient, onNotification: send, onClose });
  };
}

export async function runNetworkProxy({
  nativeSessionId,
  env = process.env,
  profile: profileValue,
  hostRecordRoot: hostRecordRootValue,
  sessionFactory: sessionFactoryValue,
  stdio = new StdioServerTransport(),
  ...options
} = {}) {
  if (typeof nativeSessionId !== 'string' || !nativeSessionId.trim()) throw new Error('CLAUDE_CODE_SESSION_ID is required for network mode.');
  const profile = profileValue ?? hostProfileFromEnv(env);
  if (!profile && !sessionFactoryValue) throw new Error('A selected host network profile is required.');
  const configPath = env.OURS_MCP_CONFIG || join(env.HOME || homedir(), '.ours-mcp', 'config.json');
  const hostRecordRoot = hostRecordRootValue ?? dirname(configPath);
  const claudeFactory = sessionFactoryValue ?? createClaudeSessionFactory({
    profile, nativeSessionId, hostRecordRoot, send: (frame) => stdio.send(frame),
  });
  return runSharedNetworkProxy({
    ...options,
    env,
    profile,
    hostRecordRoot,
    stdio,
    sessionFactory: (_selector, factoryOptions) => claudeFactory(factoryOptions),
    selectorFor: () => nativeSessionId,
  });
}

function applicationIdentities(value) {
  const text = value?.contents?.find((item) => item?.uri === 'ours://application-identities')?.text;
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed?.identities) || parsed.identities.some((name) => typeof name !== 'string')) {
    throw new Error('Invalid application identity resource.');
  }
  return parsed.identities;
}

function contentFreeUnread(value, visible) {
  const entries = Array.isArray(value?.identities) ? value.identities : [];
  return entries.flatMap((entry) => {
    if (!entry || typeof entry.name !== 'string' || !visible.has(entry.name)) return [];
    const count = Number.isSafeInteger(entry.count) ? entry.count : 0;
    if (count <= 0) return [];
    const recent = Array.isArray(entry.recent) ? entry.recent.slice(-5).flatMap((message) => (
      message && typeof message.from === 'string'
        ? [{ from: message.from, msg_id: message.msg_id ?? '?', date: typeof message.date === 'string' ? message.date : '' }]
        : []
    )) : [];
    return [{ name: entry.name, count, recent }];
  });
}

export async function readNetworkHookState({ sessionFactory }) {
  let session;
  try {
    session = await sessionFactory({});
    const resource = await session.request({ method: 'resources/read', params: { uri: 'ours://application-identities' } });
    const identities = applicationIdentities(resource);
    const visible = new Set(identities);
    const [unread, rows] = await Promise.all([session.fileClient.unread(), session.fileClient.listIdentities()]);
    const bindings = Array.isArray(rows)
      ? rows.flatMap((row) => row && ['mine', 'other-live'].includes(row.session) && visible.has(row.name) ? [row.name] : [])
      : [];
    return { identities, unread: { identities: contentFreeUnread(unread, visible) }, bindings };
  } finally {
    await session?.close();
  }
}

export async function endNetworkNativeSession({ profile, nativeSessionId, hostRecordRoot, endImpl = endNativeSessionAtRoot }) {
  await endImpl(profile, nativeSessionId, hostRecordRoot);
}

export async function runNetworkWatch({
  identity,
  nativeSessionId,
  env = process.env,
  profile: profileValue,
  hostRecordRoot: hostRecordRootValue,
  clientFor = nativeClientForAtRoot,
  write = (value) => process.stdout.write(value),
  installSignalHandlers = true,
} = {}) {
  if (typeof identity !== 'string' || !identity.trim()) throw new Error('identity is required');
  if (typeof nativeSessionId !== 'string' || !nativeSessionId.trim()) throw new Error('CLAUDE_CODE_SESSION_ID is required for network watch.');
  const profile = profileValue ?? hostProfileFromEnv(env);
  if (!profile) throw new Error('A selected host network profile is required.');
  const configPath = env.OURS_MCP_CONFIG || join(env.HOME || homedir(), '.ours-mcp', 'config.json');
  const hostRecordRoot = hostRecordRootValue ?? dirname(configPath);
  const controller = new AbortController();
  const stop = () => controller.abort();
  if (installSignalHandlers) {
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }
  let client;
  try {
    client = await clientFor(profile, nativeSessionId, hostRecordRoot);
    for await (const event of client.watchNotifications(identity, { kinds: ['inbound'], signal: controller.signal })) {
      const summary = event?.event === 'file_received'
        ? `[${identity}] new file ${event.filename ?? '?'} from ${event.from ?? '?'}`
        : `[${identity}] new message from ${event?.from ?? '?'}`;
      write(`${summary}\n`);
      return;
    }
  } finally {
    if (installSignalHandlers) {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    }
    await client?.close();
  }
}

export { hostProfileFromEnv, networkFetchForOwner };
