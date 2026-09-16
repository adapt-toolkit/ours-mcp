import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ErrorCode, McpError, ResultSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  completeHostFileCall,
  endNativeSessionAtRoot,
  hostProfileFromEnv,
  nativeClientForAtRoot,
  nativeSessionRecordPath,
  prepareHostFileCall,
} from '../../core/src/host-client/index.ts';

class NetworkTransportError extends Error {
  constructor(cause) {
    super(`Network transport failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = 'NetworkTransportError';
  }
}

function isMcpSessionLoss(error) {
  return error instanceof NetworkTransportError
    || error instanceof StreamableHTTPError
    || (error instanceof McpError && error.code === ErrorCode.ConnectionClosed);
}

function threadSelector(frame) {
  const value = frame?.params?._meta?.threadId;
  if (typeof value !== 'string' || !value || value.trim() !== value) {
    throw new Error('Native session metadata is missing or invalid for this host-profile tool call.');
  }
  return value;
}

function defaultSessionSelector(frame) {
  return frame.method === 'tools/call' ? threadSelector(frame) : '__discovery__';
}

export function createNetworkBridge({ sessionFactory, send, selectorFor = defaultSessionSelector }) {
  const sessions = new Map();
  const inFlight = new Map();
  const sessionFor = async (selector) => {
    let promise = sessions.get(selector);
    if (!promise) {
      promise = Promise.resolve(sessionFactory(selector, {
        onClose: () => { if (sessions.get(selector) === promise) sessions.delete(selector); },
      }));
      sessions.set(selector, promise);
      promise.catch(() => { if (sessions.get(selector) === promise) sessions.delete(selector); });
    }
    return promise;
  };
  const evictSession = async (selector, session) => {
    const cached = sessions.get(selector);
    if (cached && await cached.catch(() => undefined) === session && sessions.get(selector) === cached) {
      sessions.delete(selector);
    }
    await session.close().catch(() => {});
  };
  const reply = (id, value, error = false) => send(error
    ? { jsonrpc: '2.0', id, error: { code: -32000, message: value instanceof Error ? value.message : String(value) } }
    : { jsonrpc: '2.0', id, result: value });
  const handle = async (frame) => {
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return;
    if (frame.method === 'notifications/initialized') return;
    if (frame.method === 'notifications/cancelled') {
      inFlight.get(frame.params?.requestId)?.abort(frame.params?.reason);
      return;
    }
    if (frame.id === undefined || frame.id === null) {
      const session = await sessionFor(selectorFor(frame));
      await session.notification(frame);
      return;
    }
    const controller = new AbortController();
    inFlight.set(frame.id, controller);
    try {
      const selector = selectorFor(frame);
      const session = await sessionFor(selector);
      controller.signal.throwIfAborted();
      if (frame.method === 'initialize') {
        await reply(frame.id, session.initializeResult);
        return;
      }
      const requestFrame = frame.method === 'tools/call' && session.fileClient
        ? await prepareHostFileCall(session.fileClient, frame, controller.signal)
        : frame;
      controller.signal.throwIfAborted();
      let result;
      try {
        result = await session.request(
          { method: requestFrame.method, params: requestFrame.params ?? {} },
          { signal: controller.signal },
        );
      } catch (error) {
        if (isMcpSessionLoss(error)) await evictSession(selector, session);
        throw error;
      }
      controller.signal.throwIfAborted();
      let response = { jsonrpc: '2.0', id: frame.id, result };
      if (frame.method === 'tools/call' && session.fileClient) {
        response = await completeHostFileCall(session.fileClient, frame, response, controller.signal);
      }
      controller.signal.throwIfAborted();
      await send(response);
    } catch (error) {
      await reply(frame.id, error, true);
    } finally {
      if (inFlight.get(frame.id) === controller) inFlight.delete(frame.id);
    }
  };
  const close = async () => {
    for (const controller of inFlight.values()) controller.abort('stdio closed');
    await Promise.allSettled([...sessions.values()].map(async (session) => (await session).close()));
    sessions.clear();
  };
  return { handle, close };
}

export async function runNetworkProxy({
  env = process.env,
  input = process.stdin,
  stdio = new StdioServerTransport(),
  profile: profileValue,
  hostRecordRoot: hostRecordRootValue,
  sessionFactory: sessionFactoryValue,
  selectorFor,
  installSignalHandlers = true,
} = {}) {
  const profile = profileValue ?? hostProfileFromEnv(env);
  if (!profile && !sessionFactoryValue) throw new Error('A selected host network profile is required.');
  const configPath = env.OURS_MCP_CONFIG || join(env.HOME || homedir(), '.ours-mcp', 'config.json');
  const hostRecordRoot = hostRecordRootValue ?? dirname(configPath);
  const sessionFactory = sessionFactoryValue ?? createHostSessionFactory({
    profile,
    hostRecordRoot,
    send: (frame) => stdio.send(frame),
  });
  const bridge = createNetworkBridge({ sessionFactory, send: (frame) => stdio.send(frame), selectorFor });
  const tasks = new Set();
  const accept = (raw) => {
    const values = Array.isArray(raw) ? raw : [raw];
    const task = Promise.all(values.map((frame) => bridge.handle(frame)))
      .catch((error) => process.stderr.write(`ours: network proxy failed: ${error.message}\n`))
      .finally(() => tasks.delete(task));
    tasks.add(task);
  };
  stdio.onmessage = accept;
  stdio.onerror = (error) => process.stderr.write(`ours: network stdio failed: ${error.message}\n`);
  await stdio.start();

  await new Promise((resolve) => {
    let stopped = false;
    const finish = () => {
      if (stopped) return;
      stopped = true;
      input.off('end', finish);
      input.off('close', finish);
      if (installSignalHandlers) {
        process.off('SIGINT', finish);
        process.off('SIGTERM', finish);
      }
      resolve();
    };
    input.once('end', finish);
    input.once('close', finish);
    if (installSignalHandlers) {
      process.once('SIGINT', finish);
      process.once('SIGTERM', finish);
    }
  });
  await bridge.close();
  await Promise.allSettled([...tasks]);
  await stdio.close();
}
export { hostProfileFromEnv };

export function networkFetchForOwner(profile, ownerInstanceId, { fetchImpl = globalThis.fetch } = {}) {
  return async (input, init = {}) => {
    const token = readFileSync(profile.credentialPath, 'utf8').trim();
    if (!token) throw new Error(`Credential file ${profile.credentialPath} is empty.`);
    const headers = new Headers(init.headers);
    headers.set('x-ours-api-token', token);
    headers.set('x-ours-lease-token', ownerInstanceId);
    headers.set('x-ours-session-mode', 'external');
    try {
      return await fetchImpl(input, { ...init, headers, redirect: 'error' });
    } catch (error) {
      throw new NetworkTransportError(error);
    }
  };
}

export async function createMcpNetworkSession({
  profile,
  ownerInstanceId,
  fileClient,
  onNotification,
  onClose,
  ClientClass = Client,
  TransportClass = StreamableHTTPClientTransport,
  resultSchema = ResultSchema,
  clientInfo = { name: 'ours-codex', version: '2.0.0' },
}) {
  const client = new ClientClass(clientInfo);
  client.fallbackNotificationHandler = async (notification) => onNotification?.(notification);
  let invalidated = false;
  let closing;
  const evict = () => {
    if (invalidated) return;
    invalidated = true;
    onClose?.();
  };
  const invalidate = async () => {
    evict();
    closing ??= Promise.resolve(client.close()).catch(() => {});
    await closing;
  };
  client.onclose = evict;
  client.onerror = (error) => { if (isMcpSessionLoss(error)) void invalidate(); };
  const ownerHeaders = {
    'x-ours-lease-token': ownerInstanceId,
    'x-ours-session-mode': 'external',
  };
  const endpoint = new URL('/mcp', profile.endpoint);
  const transport = new TransportClass(endpoint, {
    fetch: networkFetchForOwner(profile, ownerInstanceId),
    requestInit: { headers: ownerHeaders, redirect: 'error' },
    reconnectionOptions: {
      initialReconnectionDelay: 1000,
      maxReconnectionDelay: 30_000,
      reconnectionDelayGrowFactor: 1.5,
      maxRetries: 5,
    },
  });
  await client.connect(transport);
  const instructions = client.getInstructions?.();
  const initializeResult = {
    protocolVersion: '2025-03-26',
    capabilities: client.getServerCapabilities?.() ?? {},
    serverInfo: client.getServerVersion?.() ?? { name: 'ours', version: 'unknown' },
    ...(instructions ? { instructions } : {}),
  };
  return {
    client,
    fileClient,
    initializeResult,
    request: async (request, options) => {
      try {
        return await client.request(request, resultSchema, options);
      } catch (error) {
        if (isMcpSessionLoss(error)) await invalidate();
        throw error;
      }
    },
    notification: (notification) => client.notification(notification),
    close: invalidate,
  };
}

async function nativeOwnerForAtRoot(profile, nativeSessionId, hostRecordRoot) {
  const path = nativeSessionRecordPath(hostRecordRoot, profile.expectedInstanceId, nativeSessionId);
  const record = JSON.parse(readFileSync(path, 'utf8'));
  if (record?.state !== 'active' || typeof record.ownerInstanceId !== 'string') {
    throw new Error(`Native session record at ${path} is not active.`);
  }
  return record.ownerInstanceId;
}

export function createHostSessionFactory({
  profile,
  hostRecordRoot,
  send,
  nativeClientForImpl = nativeClientForAtRoot,
  ownerForImpl = nativeOwnerForAtRoot,
  createSessionImpl = createMcpNetworkSession,
}) {
  return async (selector, { onClose } = {}) => {
    const discovery = selector === '__discovery__';
    const fileClient = discovery
      ? undefined
      : await nativeClientForImpl(profile, selector, hostRecordRoot);
    const ownerInstanceId = discovery
      ? randomUUID()
      : await ownerForImpl(profile, selector, hostRecordRoot);
    return createSessionImpl({
      profile,
      ownerInstanceId,
      fileClient,
      onNotification: send,
      onClose,
    });
  };
}

export async function endNetworkNativeSession({
  profile,
  nativeSessionId,
  hostRecordRoot,
  endImpl = endNativeSessionAtRoot,
}) {
  await endImpl(profile, nativeSessionId, hostRecordRoot);
}
