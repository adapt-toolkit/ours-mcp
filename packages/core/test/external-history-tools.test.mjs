import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { OursError } from '@ours.network/sdk';

import { createOursMcpServer } from '../dist/server.js';

const calls = [];
const message = {
  seq: 9,
  msg_id: 9,
  wire_id: 'A'.repeat(64),
  from: { id: 'peer-a', name: 'Peer A' },
  peer: { id: 'peer-a', name: 'Peer A' },
  direction: 'in',
  text: 'hello',
  body: 'hello',
  occurred_at_ms: 1_700_000_000_000,
  date: '2023-11-14T22:13:20.000Z',
  encryption: 'e2e',
  transport: 'double_ratchet',
  inbox_state: 'read',
  status: 'read',
  delivery_state: 'read',
  human_read_at_ms: null,
  reply_to: null,
};
const file = {
  seq: 12,
  file_id: 12,
  wire_id: 'B'.repeat(64),
  from: { id: 'peer-a', name: 'Peer A' },
  peer: { id: 'peer-a', name: 'Peer A' },
  direction: 'in',
  filename: 'report.txt',
  mime: 'text/plain',
  size: 6,
  byte_length: 6,
  sha256: 'C'.repeat(64),
  occurred_at_ms: 1_700_000_000_000,
  date: '2023-11-14T22:13:20.000Z',
  encryption: 'e2e',
  inbox_state: 'read',
  status: 'read',
  delivery_state: 'delivered',
  human_read_at_ms: null,
  reply_to: null,
  blob_path: '/daemon/private/blob',
  kind: 'file',
};

const fakeClient = {
  currentIdentity: async () => ({ name: 'Alice' }),
  sendMessage: async (input) => {
    calls.push(['sendMessage', input]);
    return {
      kind: 'sent',
      wireId: 'D'.repeat(64),
      wire_id: 'D'.repeat(64),
      sent: true,
      history_stored: false,
    };
  },
  listHistory: async (query) => { calls.push(['listHistory', query]); return { items: [message], next_cursor: 9 }; },
  getHistoryItem: async (input) => { calls.push(['getHistoryItem', input]); return input.wire_id === message.wire_id ? message : null; },
  listFiles: async (query) => { calls.push(['listFiles', query]); return { items: [file], next_cursor: null }; },
  getFileInfo: async (input) => { calls.push(['getFileInfo', input]); return input.wire_id === file.wire_id ? file : null; },
  getMessages: async (input) => { calls.push(['getMessages', input]); return { messages: [message], remaining: 2 }; },
  listIncomingFiles: async () => [],
  getFiles: async (input) => {
    calls.push(['getFiles', input]);
    if (input.wire_ids?.[0] === 'bad') {
      throw new OursError('MALFORMED_ID', 'get_files failed: every selected wire_id must be exactly 64 hexadecimal characters.');
    }
    return { files: [], text: 'No new files.', mode: 'all_unread', requested: null, remaining: 3 };
  },
  openFile: async (wireId) => {
    calls.push(['openFile', wireId]);
    return new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('stored'));
        controller.close();
      },
    });
  },
};

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const server = createOursMcpServer(fakeClient, 'test', {});
const client = new Client({ name: 'history-test', version: '1' }, { capabilities: {} });

await server.connect(serverTransport);
await client.connect(clientTransport);

try {
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name).sort();
  for (const required of ['get_file_info', 'get_history_item', 'get_messages', 'list_files', 'list_history', 'save_file']) {
    assert.ok(names.includes(required), `${required} is registered`);
  }
  const forbidden = ['list_' + 'incoming_messages', 'defer_' + 'messages'];
  for (const removed of forbidden) assert.ok(!names.includes(removed), `${removed} is absent`);
  assert.equal(client.getServerCapabilities()?.resources, undefined, 'server advertises no resource capability');

  const historyTool = listed.tools.find((tool) => tool.name === 'list_history');
  assert.equal(historyTool.inputSchema.properties.limit.maximum, 200);
  assert.deepEqual(historyTool.inputSchema.properties.direction.enum, ['in', 'out']);

  const page = await client.callTool({
    name: 'list_history',
    arguments: { peer_cid: 'peer-a', direction: 'in', before_seq: 20, limit: 7 },
  });
  assert.equal(page.isError, false);
  assert.deepEqual(page.structuredContent, { count: 1, items: [message], next_cursor: 9 });
  assert.deepEqual(calls.at(-1), ['listHistory', { peer_cid: 'peer-a', direction: 'in', before_seq: 20, limit: 7 }]);

  const missing = await client.callTool({ name: 'get_history_item', arguments: { wire_id: 'missing' } });
  assert.deepEqual(missing.structuredContent, { item: null });

  const filePage = await client.callTool({ name: 'list_files', arguments: { limit: 5 } });
  assert.deepEqual(filePage.structuredContent, { count: 1, items: [file], next_cursor: null });
  const fileInfo = await client.callTool({ name: 'get_file_info', arguments: { wire_id: file.wire_id } });
  assert.deepEqual(fileInfo.structuredContent, { item: file });

  const unread = await client.callTool({ name: 'get_messages', arguments: { limit: 4 } });
  assert.deepEqual(unread.structuredContent, { count: 1, messages: [message], remaining: 2 });
  assert.deepEqual(calls.at(-1), ['getMessages', { limit: 4 }]);

  const sent = await client.callTool({ name: 'send_message', arguments: { contact: 'Peer A', text: 'hello' } });
  assert.equal(sent.isError, false);
  assert.equal(sent.structuredContent.outcome.history_stored, false);
  assert.match(sent.content[0].text, /not stored in this identity's local history/i);
  assert.deepEqual(calls.at(-1), ['sendMessage', {
    contact: 'Peer A', text: 'hello', reply_to_wire_id: undefined, reply_to_sentence: undefined,
  }]);

  const files = await client.callTool({ name: 'get_files', arguments: { limit: 6 } });
  assert.equal(files.isError, false);
  assert.equal(files.structuredContent.remaining, 3);
  assert.deepEqual(calls.at(-1), ['getFiles', { wire_ids: undefined, limit: 6 }]);

  const bad = await client.callTool({ name: 'get_files', arguments: { wire_ids: ['bad'] } });
  assert.equal(bad.isError, true);
  assert.equal(bad.structuredContent.error.category, 'malformed_id');
  assert.deepEqual(bad.structuredContent.selection.items, [{ wire_id: 'bad', status: 'error', error_category: 'malformed_id' }]);

  const root = mkdtempSync(join(tmpdir(), 'ours-history-save-'));
  try {
    const dest = join(root, 'nested', 'report.txt');
    const saved = await client.callTool({ name: 'save_file', arguments: { wire_id: file.wire_id, dest_path: dest } });
    assert.equal(saved.isError, false);
    assert.equal(readFileSync(dest, 'utf8'), 'stored');
    assert.deepEqual(calls.at(-1), ['openFile', file.wire_id]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
} finally {
  await client.close();
  await server.close();
}

console.log('external-history-tools: registrations, queries, bounded reads, errors, and streaming verified');
