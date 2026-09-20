import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createOursMcpServer } from '../dist/server.js';

test('local MCP handles host files while the SDK carries only uploads and downloads', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ours-local-file-tools-'));
  const source = join(root, 'source.txt');
  writeFileSync(source, 'host-only file bytes');
  const calls = [];
  const sdk = {
    currentIdentity: async () => ({ name: 'Agent' }),
    defineLocalIdentityFile: async () => { throw new Error('must not write on remote daemon'); },
    uploadFile: async (bytes, metadata) => { calls.push(['upload', await new Response(bytes).text(), metadata]); return { upload_id: 'uploaded' }; },
    sendFile: async args => { calls.push(['send', args]); return { kind: 'e2e', filename: 'source.txt', bytes: 20, wireId: 'ABC123' }; },
    openFile: async id => { assert.equal(id, 'ABC123'); return new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('downloaded bytes')); c.close(); } }); },
    getFiles: async () => ({ text: 'Remote file', files: [{ wire_id: 'ABC123', status: 'saved', path: source, filename: 'source.txt' }], mode: 'unread', remaining: 0 }),
  };
  const [a,b] = InMemoryTransport.createLinkedPair();
  const server = createOursMcpServer(sdk, 'test', { list: async () => [] }, { remoteDaemonFiles: true });
  const client = new Client({ name: 'test', version: '1' });
  await server.connect(b); await client.connect(a);
  try {
    const pin = await client.callTool({ name: 'define_local_identity_file', arguments: { name: 'Agent', path: root } });
    assert.equal(pin.isError, false, JSON.stringify(pin));
    assert.equal(JSON.parse(readFileSync(join(root,'.ours-identity'),'utf8')).identity, 'Agent');
    const sent = await client.callTool({ name: 'send_file', arguments: { contact: 'Peer', path: source } });
    assert.equal(sent.isError, false, JSON.stringify(sent));
    assert.equal(calls[0][1], 'host-only file bytes');
    assert.equal(calls[1][1].upload_id, 'uploaded');
    assert.equal(calls[1][1].path, undefined, 'a host path never reaches the daemon');
    const dest = join(root, 'downloads/file.txt');
    const saved = await client.callTool({ name: 'save_file', arguments: { wire_id: 'ABC123', dest_path: dest } });
    assert.equal(saved.isError, false, JSON.stringify(saved));
    assert.equal(readFileSync(dest, 'utf8'), 'downloaded bytes');
    const files = await client.callTool({ name: 'get_files', arguments: {} });
    assert.equal(files.isError, false, JSON.stringify(files));
    assert.match(JSON.stringify(files.content), /save_file/, 'remote paths remain remote even when a local path happens to exist');
  } finally { await client.close(); await server.close(); rmSync(root, { recursive: true, force: true }); }
});

test('cancelling a staged upload prevents the send after upload completion', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ours-cancel-upload-'));
  const source = join(root, 'source.txt'); writeFileSync(source, 'bytes');
  let started, finish; let sends = 0;
  const uploading = new Promise(resolve => { started = resolve; });
  const uploaded = new Promise(resolve => { finish = resolve; });
  const sdk = { currentIdentity: async () => ({ name: 'Agent' }),
    uploadFile: async body => { await new Response(body).text(); started(); await uploaded; return { upload_id: 'staged' }; },
    sendFile: async () => { sends++; return { kind: 'e2e', filename: 'source.txt', bytes: 5, wireId: 'ABC' }; },
  };
  const [a,b] = InMemoryTransport.createLinkedPair();
  const server = createOursMcpServer(sdk, 'test', { list: async () => [] });
  const client = new Client({ name: 'test', version: '1' });
  await server.connect(b); await client.connect(a);
  try {
    const abort = new AbortController();
    const pending = client.callTool({ name: 'send_file', arguments: { contact: 'Peer', path: source } }, undefined, { signal: abort.signal });
    const rejected = assert.rejects(pending);
    await uploading; abort.abort(); await rejected;
    await new Promise(resolve => setImmediate(resolve)); finish();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(sends, 0, 'a cancelled upload must not send');
  } finally { finish(); await client.close(); await server.close(); rmSync(root, { recursive: true, force: true }); }
});

test('cancelling save_file cancels its byte stream', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ours-cancel-download-'));
  let opened, cancelled;
  const opening = new Promise(resolve => { opened = resolve; });
  const cancellation = new Promise(resolve => { cancelled = resolve; });
  const sdk = { openFile: async () => new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode('partial')); opened(); },
    cancel() { cancelled(); },
  }) };
  const [a,b] = InMemoryTransport.createLinkedPair();
  const server = createOursMcpServer(sdk, 'test', { list: async () => [] });
  const client = new Client({ name: 'test', version: '1' });
  await server.connect(b); await client.connect(a);
  try {
    const abort = new AbortController();
    const pending = client.callTool({ name: 'save_file', arguments: { wire_id: 'ABC', dest_path: join(root, 'file') } }, undefined, { signal: abort.signal });
    const rejected = assert.rejects(pending);
    await opening; abort.abort(); await rejected;
    await Promise.race([cancellation, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('download did not cancel')), 1000); timer.unref(); })]);
  } finally { await client.close(); await server.close(); rmSync(root, { recursive: true, force: true }); }
});
