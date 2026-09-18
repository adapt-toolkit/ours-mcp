import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  hostProfileFromEnv,
  createNetworkBridge,
  networkFetchForOwner,
  readNetworkHookState,
  runNetworkWatch,
} from '../dist/network-client.mjs';

test('one Claude session forwards metadata and cancellation through one upstream owner', async () => {
  let finishSession;
  let requestCount = 0;
  const output = [];
  const bridge = createNetworkBridge({
    send: async (frame) => output.push(frame),
    sessionFactory: ({ onClose }) => new Promise((resolve) => {
      finishSession = () => resolve({
        initializeResult: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'ours', version: '2' } },
        notification: async () => {},
        close: async () => onClose(),
        request: async () => { requestCount += 1; return { isError: false }; },
      });
    }),
  });
  const pending = bridge.handle({
    jsonrpc: '2.0', id: 41, method: 'tools/call',
    params: { name: 'send_message', arguments: { contact: 'Peer', text: 'do not replay' }, _meta: { progressToken: 'p-41' } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  await bridge.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 41, reason: 'user stopped' } });
  finishSession();
  await pending;
  assert.equal(requestCount, 0, 'cancellation before attachment prevents the mutation');
  assert.match(output[0].error.message, /user stopped/);
  await bridge.close();
});

test('Claude host file calls upload and save byte-identical data', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ours-claude-network-files-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source.bin');
  const destination = join(root, 'nested', 'saved.bin');
  const sourceBytes = Buffer.from([0, 1, 2, 255, 10]);
  const savedBytes = Buffer.from([9, 8, 0, 7, 255]);
  writeFileSync(source, sourceBytes);
  const requests = [];
  const output = [];
  const bridge = createNetworkBridge({
    send: async (frame) => output.push(frame),
    sessionFactory: async () => ({
      fileClient: {
        uploadFile: async (body, metadata) => {
          assert.deepEqual(Buffer.from(await new Response(body).arrayBuffer()), sourceBytes);
          assert.deepEqual(metadata, { filename: 'advertised.bin', mime: 'x/test', size: sourceBytes.length });
          return { upload_id: 'upload-1' };
        },
        openFile: async () => new ReadableStream({ start(controller) { controller.enqueue(savedBytes); controller.close(); } }),
      },
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
  await bridge.handle({ jsonrpc: '2.0', id: 'send', method: 'tools/call', params: { name: 'send_file', arguments: { contact: 'Peer', path: source, filename: 'advertised.bin', mime: 'x/test' } } });
  await bridge.handle({ jsonrpc: '2.0', id: 'save', method: 'tools/call', params: { name: 'save_file', arguments: { wire_id: 'wire-1', dest_path: destination } } });
  assert.deepEqual(requests[0].params.arguments, { contact: 'Peer', upload_id: 'upload-1', filename: 'advertised.bin', mime: 'x/test' });
  assert.deepEqual(readFileSync(destination), savedBytes);
  assert.equal(output[1].result.isError, false);
  assert.equal(Object.hasOwn(output[1].result, 'structuredContent'), false);
  await bridge.close();
});

test('network requests reread the protected credential and enforce owner headers', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ours-claude-network-token-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const credentialPath = join(root, 'token');
  const seen = [];
  const fetchWithOwner = networkFetchForOwner({ credentialPath }, 'owner-uuid', {
    fetchImpl: async (_input, init) => { seen.push(Object.fromEntries(new Headers(init.headers))); return new Response('', { status: 200 }); },
  });
  writeFileSync(credentialPath, 'token-one\n', { mode: 0o600 });
  await fetchWithOwner('http://127.0.0.1/mcp', { headers: { 'x-ours-api-token': 'wrong' } });
  writeFileSync(credentialPath, 'token-two\n', { mode: 0o600 });
  await fetchWithOwner('http://127.0.0.1/mcp');
  assert.deepEqual(seen.map((headers) => [headers['x-ours-api-token'], headers['x-ours-lease-token'], headers['x-ours-session-mode']]), [
    ['token-one', 'owner-uuid', 'external'],
    ['token-two', 'owner-uuid', 'external'],
  ]);
});

test('network hook state combines server application visibility with SDK unread and binding rows', async () => {
  const calls = [];
  const state = await readNetworkHookState({
    sessionFactory: async () => ({
      request: async (request) => {
        calls.push(request);
        return { contents: [{ uri: 'ours://application-identities', text: JSON.stringify({ identities: ['Alice', 'Bob'] }) }] };
      },
      fileClient: {
        unread: async () => ({ identities: [
          { name: 'Alice', count: 1, recent: [{ from: 'Peer', msg_id: 7, date: 'today', body: 'SECRET' }] },
          { name: 'Mallory', count: 9, recent: [{ from: 'Hidden', body: 'SECRET' }] },
        ] }),
        listIdentities: async () => [
          { name: 'Alice', session: 'mine' },
          { name: 'Bob', session: 'other-live' },
          { name: 'Mallory', session: 'mine' },
        ],
      },
      close: async () => { calls.push('close'); },
    }),
  });
  assert.deepEqual(state, {
    identities: ['Alice', 'Bob'],
    bindings: ['Alice', 'Bob'],
    unread: { identities: [{ name: 'Alice', count: 1, recent: [{ from: 'Peer', msg_id: 7, date: 'today' }] }] },
  });
  assert.deepEqual(calls, [{ method: 'resources/read', params: { uri: 'ours://application-identities' } }, 'close']);
});

test('network watch uses the same native session and emits body-free arrival metadata', async () => {
  const calls = [];
  let output = '';
  let closed = false;
  const client = {
    async *watchNotifications(identity, options) {
      calls.push(['watch', identity, options.kinds]);
      yield { event: 'message_received', from: 'Peer', body: 'SECRET' };
    },
    close: async () => { closed = true; },
  };
  await runNetworkWatch({
    identity: 'Alice', nativeSessionId: 'claude-session-a',
    profile: { endpoint: 'http://127.0.0.1:4050', expectedInstanceId: 'b282ca8e-72d2-48cc-a948-b3c1a62129f5', credentialPath: '/host/token' },
    hostRecordRoot: '/host/private',
    clientFor: async (_profile, nativeSessionId, root) => { calls.push(['client', nativeSessionId, root]); return client; },
    write: (value) => { output += value; }, installSignalHandlers: false,
  });
  assert.deepEqual(calls, [['client', 'claude-session-a', '/host/private'], ['watch', 'Alice', ['inbound']]]);
  assert.match(output, /new message from Peer/);
  assert.doesNotMatch(output, /SECRET/);
  assert.equal(closed, true);
});

test('rebuilt Claude client selects the managed profile before legacy container configuration', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ours-claude-managed-'));
  try {
    mkdirSync(join(home, '.ours-client'), { mode: 0o700 });
    mkdirSync(join(home, '.ours'), { mode: 0o700 });
    const profile = { endpoint: 'http://127.0.0.1:4567', expectedInstanceId: '12345678-1234-1234-1234-123456789abc', credentialPath: join(home, 'credential') };
    writeFileSync(join(home, '.ours-client', 'profile.json'), JSON.stringify(profile), { mode: 0o600 });
    writeFileSync(join(home, '.ours', 'config.json'), JSON.stringify({ composeFile: '/must-not-use-docker.yaml', expectedInstanceId: profile.expectedInstanceId }));
    assert.deepEqual(hostProfileFromEnv({ HOME: home }), profile);
    const { spawnSync } = await import('node:child_process');
    const env = { ...process.env, HOME: home };
    for (const key of ['OURS_CONFIG', 'OURS_API_TOKEN', 'OURS_PORT', 'OURS_STATE_DIR', 'OURS_DAEMON_ID']) delete env[key];
    const proxy = spawnSync(process.execPath, [new URL('../bin/proxy.mjs', import.meta.url).pathname, 'session-end'], { env, input: '{}', encoding: 'utf8' });
    assert.notEqual(proxy.status, 0);
    assert.match(proxy.stderr, /SessionEnd requires session_id/, 'network branch selected before Docker or local main MCP');
  } finally { rmSync(home, { recursive: true, force: true }); }
});
