import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { McpError } from '@modelcontextprotocol/sdk/types.js';

import { createNetworkBridge, runNetworkProxy } from '../dist/network-proxy.mjs';

test('network bridge exposes the package-local stdio relay', async () => {
  const module = await import('../dist/network-proxy.mjs');
  assert.equal(typeof module.createNetworkBridge, 'function');
});

test('tool calls from different Codex threads keep independent upstream owners and downstream ids', async () => {
  const created = [];
  const requests = [];
  const output = [];
  const sessionFactory = async (selector) => {
    created.push(selector);
    return {
      initializeResult: {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'ours', version: '2.0.0' },
      },
      request: async (request) => {
        requests.push([selector, structuredClone(request)]);
        return { content: [{ type: 'text', text: selector }], isError: false };
      },
      notification: async () => {},
      close: async () => {},
    };
  };
  const bridge = createNetworkBridge({ sessionFactory, send: async (frame) => output.push(frame) });
  await bridge.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  for (const [id, threadId] of [[7, 'thread-a'], [8, 'thread-b'], [9, 'thread-a']]) {
    await bridge.handle({
      jsonrpc: '2.0', id, method: 'tools/call',
      params: { name: 'current_identity', arguments: {}, _meta: { threadId, progressToken: `progress-${id}` } },
    });
  }
  assert.deepEqual(created, ['__discovery__', 'thread-a', 'thread-b']);
  assert.deepEqual(requests.map(([selector, request]) => [selector, request.params._meta.threadId, request.params._meta.progressToken]), [
    ['thread-a', 'thread-a', 'progress-7'],
    ['thread-b', 'thread-b', 'progress-8'],
    ['thread-a', 'thread-a', 'progress-9'],
  ]);
  assert.deepEqual(output.map((frame) => frame.id), [1, 7, 8, 9]);
  assert.deepEqual(output.slice(1).map((frame) => frame.result.content[0].text), ['thread-a', 'thread-b', 'thread-a']);
});

test('cancellation aborts only its owning request and EOF closes transports without releasing owners', async () => {
  const controllers = new Map();
  const closed = [];
  const output = [];
  const sessionFactory = async (selector) => ({
    initializeResult: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'ours', version: '2' } },
    request: (request, { signal }) => new Promise((resolve, reject) => {
      controllers.set(selector, signal);
      signal.addEventListener('abort', () => reject(new Error(`cancelled ${selector}`)), { once: true });
    }),
    notification: async () => {},
    close: async () => { closed.push(selector); },
  });
  const bridge = createNetworkBridge({ sessionFactory, send: async (frame) => output.push(frame) });
  const pending = bridge.handle({
    jsonrpc: '2.0', id: 33, method: 'tools/call',
    params: { name: 'get_messages', arguments: {}, _meta: { threadId: 'thread-a' } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  await bridge.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 33, reason: 'user stopped' } });
  await pending;
  assert.equal(controllers.get('thread-a').aborted, true);
  assert.equal(controllers.has('thread-b'), false);
  assert.match(output[0].error.message, /cancelled thread-a/);
  await bridge.close();
  assert.deepEqual(closed, ['thread-a']);
});

test('cancellation registered during session creation prevents the tool mutation', async () => {
  let finishSession;
  let requestCount = 0;
  const output = [];
  const bridge = createNetworkBridge({
    send: async (frame) => output.push(frame),
    sessionFactory: () => new Promise((resolve) => { finishSession = resolve; }),
  });
  const pending = bridge.handle({
    jsonrpc: '2.0', id: 34, method: 'tools/call',
    params: { name: 'send_message', arguments: { contact: 'Peer', text: 'must not send' }, _meta: { threadId: 'thread-a' } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  await bridge.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 34, reason: 'user stopped' } });
  finishSession({
    initializeResult: {}, notification: async () => {}, close: async () => {},
    request: async () => { requestCount += 1; return { isError: false }; },
  });
  await pending;
  assert.equal(requestCount, 0, 'a cancelled mutation must never be sent after attachment completes');
  assert.match(output[0].error.message, /user stopped/);
  await bridge.close();
});

test('cancelling one request does not close or fail a sibling request on the same transport', async () => {
  const pending = new Map();
  const output = [];
  let closeCount = 0;
  const bridge = createNetworkBridge({
    send: async (frame) => output.push(frame),
    sessionFactory: async () => ({
      initializeResult: {}, notification: async () => {}, close: async () => { closeCount += 1; },
      request: (request, { signal }) => new Promise((resolve, reject) => {
        const text = request.params.arguments.text;
        pending.set(text, resolve);
        signal.addEventListener('abort', () => reject(new McpError(-32001, String(signal.reason))), { once: true });
      }),
    }),
  });
  const call = (id, text) => bridge.handle({
    jsonrpc: '2.0', id, method: 'tools/call',
    params: { name: 'send_message', arguments: { contact: 'Peer', text }, _meta: { threadId: 'thread-shared' } },
  });
  const cancelled = call(35, 'cancelled');
  const sibling = call(36, 'sibling');
  await new Promise((resolve) => setImmediate(resolve));
  await bridge.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 35, reason: 'user stopped' } });
  await cancelled;
  pending.get('sibling')({ content: [{ type: 'text', text: 'sibling succeeded' }], isError: false });
  await sibling;
  assert.equal(closeCount, 0);
  assert.match(output.find((frame) => frame.id === 35).error.message, /user stopped/);
  assert.equal(output.find((frame) => frame.id === 36).result.content[0].text, 'sibling succeeded');
  await bridge.close();
});

test('application request errors preserve the shared upstream session', async () => {
  const output = [];
  let created = 0;
  let calls = 0;
  const bridge = createNetworkBridge({
    send: async (frame) => output.push(frame),
    sessionFactory: async () => {
      created += 1;
      return {
        initializeResult: {}, notification: async () => {}, close: async () => {},
        request: async () => {
          calls += 1;
          if (calls === 1) throw new McpError(-32602, 'invalid application arguments');
          return { content: [{ type: 'text', text: 'same session' }], isError: false };
        },
      };
    },
  });
  const call = (id) => bridge.handle({
    jsonrpc: '2.0', id, method: 'tools/call',
    params: { name: 'current_identity', arguments: {}, _meta: { threadId: 'thread-app-error' } },
  });
  await call(37);
  await call(38);
  assert.match(output[0].error.message, /invalid application arguments/);
  assert.equal(output[1].result.content[0].text, 'same session');
  assert.equal(created, 1);
  await bridge.close();
});

test('a failed upstream session is disposed and the next explicit request reconnects without replay', async (t) => {
  const network = await import('../dist/network-proxy.mjs');
  const transportRoot = mkdtempSync(join(tmpdir(), 'ours-codex-transport-failure-'));
  t.after(() => rmSync(transportRoot, { recursive: true, force: true }));
  const credentialPath = join(transportRoot, 'token');
  writeFileSync(credentialPath, 'test-token\n', { mode: 0o600 });
  let transportFailure;
  try {
    await network.networkFetchForOwner({ credentialPath }, 'owner', {
      fetchImpl: async () => { throw new Error('stale mcp-session-id'); },
    })('http://127.0.0.1/mcp');
  } catch (error) {
    transportFailure = error;
  }
  assert.ok(transportFailure);
  const output = [];
  const closed = [];
  let created = 0;
  let requests = 0;
  const bridge = createNetworkBridge({
    send: async (frame) => output.push(frame),
    sessionFactory: async (_selector, { onClose }) => {
      const generation = ++created;
      return {
        initializeResult: {}, notification: async () => {},
        request: async () => {
          requests += 1;
          if (generation === 1) throw transportFailure;
          return { content: [{ type: 'text', text: 'reconnected' }], isError: false };
        },
        close: async () => { closed.push(generation); onClose(); },
      };
    },
  });
  const call = (id) => bridge.handle({
    jsonrpc: '2.0', id, method: 'tools/call',
    params: { name: 'current_identity', arguments: {}, _meta: { threadId: 'thread-a' } },
  });
  await call(40);
  assert.match(output[0].error.message, /stale mcp-session-id/);
  assert.equal(requests, 1, 'the failed request is not replayed');
  await call(41);
  assert.equal(output[1].result.content[0].text, 'reconnected');
  assert.equal(created, 2, 'the later explicit request creates a fresh MCP transport');
  assert.deepEqual(closed, [1]);
  await bridge.close();
});

test('host file calls stream byte-identical data around the network tool result', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ours-codex-network-files-'));
  const source = join(root, 'source.bin');
  const destination = join(root, 'nested', 'saved.bin');
  const sourceBytes = Buffer.from([0, 1, 2, 255, 10]);
  const savedBytes = Buffer.from([9, 8, 0, 7, 255]);
  writeFileSync(source, sourceBytes);
  const requests = [];
  const output = [];
  try {
    const fileClient = {
      uploadFile: async (body, metadata) => {
        assert.deepEqual(Buffer.from(await new Response(body).arrayBuffer()), sourceBytes);
        assert.deepEqual(metadata, { filename: 'advertised.bin', mime: 'x/test', size: sourceBytes.length });
        return { upload_id: 'upload-1' };
      },
      openFile: async (wireId) => {
        assert.equal(wireId, 'wire-1');
        return new ReadableStream({ start(controller) { controller.enqueue(savedBytes); controller.close(); } });
      },
    };
    const bridge = createNetworkBridge({
      send: async (frame) => output.push(frame),
      sessionFactory: async () => ({
        fileClient,
        initializeResult: {}, notification: async () => {}, close: async () => {},
        request: async (request) => {
          requests.push(structuredClone(request));
          if (request.params.name === 'send_file') return { content: [{ type: 'text', text: 'sent' }], isError: false };
          return {
            content: [{ type: 'text', text: 'host save pending' }], isError: false,
            structuredContent: { oursHostSave: { wire_id: 'wire-1', dest_path: destination } },
          };
        },
      }),
    });
    await bridge.handle({
      jsonrpc: '2.0', id: 'send', method: 'tools/call',
      params: { name: 'send_file', arguments: { contact: 'Peer', path: source, filename: 'advertised.bin', mime: 'x/test' }, _meta: { threadId: 'thread-files' } },
    });
    await bridge.handle({
      jsonrpc: '2.0', id: 'save', method: 'tools/call',
      params: { name: 'save_file', arguments: { wire_id: 'wire-1', dest_path: destination }, _meta: { threadId: 'thread-files' } },
    });
    assert.deepEqual(requests[0].params.arguments, { contact: 'Peer', upload_id: 'upload-1', filename: 'advertised.bin', mime: 'x/test' });
    assert.deepEqual(readFileSync(destination), savedBytes);
    assert.equal(output[1].result.isError, false);
    assert.equal(Object.hasOwn(output[1].result, 'structuredContent'), false);
    assert.match(output[1].result.content[0].text, new RegExp(destination.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('network transport rereads the protected credential for every HTTP request', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ours-codex-network-token-'));
  const credentialPath = join(root, 'token');
  const seen = [];
  try {
    writeFileSync(credentialPath, 'token-one\n', { mode: 0o600 });
    const module = await import('../dist/network-proxy.mjs');
    const fetchWithOwner = module.networkFetchForOwner?.(
      { credentialPath }, 'b282ca8e-72d2-48cc-a948-b3c1a62129f5',
      { fetchImpl: async (_input, init) => { seen.push(Object.fromEntries(new Headers(init.headers))); return new Response('', { status: 200 }); } },
    );
    await fetchWithOwner('http://127.0.0.1/mcp', { headers: { 'x-ours-api-token': 'wrong', 'x-ours-lease-token': 'wrong' } });
    writeFileSync(credentialPath, 'token-two\n', { mode: 0o600 });
    await fetchWithOwner('http://127.0.0.1/mcp', {});
    assert.deepEqual(seen.map((headers) => [
      headers['x-ours-api-token'], headers['x-ours-lease-token'], headers['x-ours-session-mode'],
    ]), [
      ['token-one', 'b282ca8e-72d2-48cc-a948-b3c1a62129f5', 'external'],
      ['token-two', 'b282ca8e-72d2-48cc-a948-b3c1a62129f5', 'external'],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('MCP network session connects to /mcp and forwards requests and server notifications', async () => {
  const calls = [];
  const notifications = [];
  class FakeTransport {
    constructor(url, options) { calls.push(['transport', url.href, options]); }
    async close() { calls.push(['transport-close']); }
  }
  class FakeClient {
    async connect(transport) { this.transport = transport; calls.push(['connect']); }
    getServerCapabilities() { return { tools: {}, resources: {} }; }
    getServerVersion() { return { name: 'ours', version: '2.0.0' }; }
    getInstructions() { return 'network server'; }
    async request(request, _schema, options) { calls.push(['request', request, options]); return { ok: true }; }
    async notification(notification) { calls.push(['notification', notification]); }
    async close() { calls.push(['client-close']); }
  }
  const module = await import('../dist/network-proxy.mjs');
  const session = await module.createMcpNetworkSession?.({
    profile: { endpoint: 'http://127.0.0.1:4050', credentialPath: '/credential' },
    ownerInstanceId: 'b282ca8e-72d2-48cc-a948-b3c1a62129f5',
    onNotification: async (frame) => notifications.push(frame),
    ClientClass: FakeClient,
    TransportClass: FakeTransport,
    resultSchema: {},
  });
  assert.equal(calls[0][1], 'http://127.0.0.1:4050/mcp');
  assert.deepEqual(session.initializeResult, {
    protocolVersion: '2025-03-26', capabilities: { tools: {}, resources: {} },
    serverInfo: { name: 'ours', version: '2.0.0' }, instructions: 'network server',
  });
  await session.request({ method: 'tools/list', params: {} }, { signal: AbortSignal.timeout(1000) });
  await session.notification({ method: 'notifications/initialized' });
  await session.client.fallbackNotificationHandler({ method: 'notifications/message', params: { data: 'mail' } });
  assert.deepEqual(notifications, [{ method: 'notifications/message', params: { data: 'mail' } }]);
  await session.close();
  assert.deepEqual(calls.map((entry) => entry[0]), ['transport', 'connect', 'request', 'notification', 'client-close']);
});

test('host session factory reuses the durable native owner and explicit host record root', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ours-codex-owner-factory-'));
  const profile = {
    endpoint: 'http://127.0.0.1:4050',
    expectedInstanceId: 'b282ca8e-72d2-48cc-a948-b3c1a62129f5',
    credentialPath: join(root, 'token'),
  };
  const owner = '20c8bcd5-c5c3-483d-9953-50a27acc2f40';
  const fileClient = { name: 'file-client' };
  const calls = [];
  try {
    const module = await import('../dist/network-proxy.mjs');
    const factory = module.createHostSessionFactory?.({
      profile,
      hostRecordRoot: root,
      send: async () => {},
      nativeClientForImpl: async (...args) => { calls.push(['native', ...args]); return fileClient; },
      ownerForImpl: async (...args) => { calls.push(['owner', ...args]); return owner; },
      createSessionImpl: async (options) => { calls.push(['session', options]); return options; },
    });
    const session = await factory('thread-a', { onClose: () => {} });
    assert.deepEqual(calls[0], ['native', profile, 'thread-a', root]);
    assert.deepEqual(calls[1], ['owner', profile, 'thread-a', root]);
    assert.equal(calls[2][0], 'session');
    assert.equal(session.ownerInstanceId, owner);
    assert.equal(session.fileClient, fileClient);
    assert.equal(session.profile, profile);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('network proxy serves stdio until EOF and then closes upstream transports', async () => {
  const input = new EventEmitter();
  const sent = [];
  let sessionClosed = false;
  let stdioClosed = false;
  const stdio = {
    start: async () => {},
    send: async (frame) => sent.push(frame),
    close: async () => { stdioClosed = true; },
  };
  const running = runNetworkProxy({
    input,
    stdio,
    installSignalHandlers: false,
    sessionFactory: async (selector) => ({
      initializeResult: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'ours', version: '2' } },
      request: async () => ({ content: [{ type: 'text', text: selector }], isError: false }),
      notification: async () => {},
      close: async () => { sessionClosed = true; },
    }),
  });
  stdio.onmessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  stdio.onmessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'current_identity', arguments: {}, _meta: { threadId: 'thread-a' } } });
  await new Promise((resolve) => setImmediate(resolve));
  input.emit('end');
  await running;
  assert.deepEqual(sent.map((frame) => frame.id).sort(), [1, 2]);
  assert.equal(sessionClosed, true);
  assert.equal(stdioClosed, true);
});

test('SessionEnd releases the exact native owner through the explicit host record root', async () => {
  const calls = [];
  const module = await import('../dist/network-proxy.mjs');
  const profile = { endpoint: 'http://127.0.0.1:4050', expectedInstanceId: 'b282ca8e-72d2-48cc-a948-b3c1a62129f5', credentialPath: '/token' };
  await module.endNetworkNativeSession?.({
    profile,
    nativeSessionId: 'thread-a',
    hostRecordRoot: '/host/private',
    endImpl: async (...args) => calls.push(args),
  });
  assert.deepEqual(calls, [[profile, 'thread-a', '/host/private']]);
});
