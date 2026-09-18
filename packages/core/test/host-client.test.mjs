import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  completeHostFileCall,
  nativeSessionRecordPath,
  prepareHostFileCall,
} from '../dist/host-client.js';

const root = mkdtempSync(join(tmpdir(), 'ours-host-client-'));
const source = join(root, 'source.bin');
const destination = join(root, 'nested', 'saved.bin');
const bytes = Buffer.from([0, 1, 2, 250, 255]);
writeFileSync(source, bytes);
const calls = [];
const client = {
  uploadFile: async (stream, metadata) => {
    calls.push(['uploadFile', Buffer.from(await new Response(stream).arrayBuffer()), metadata]);
    return { upload_id: 'staged-1', size: bytes.length, sha256: 'x' };
  },
  openFile: async (wireId) => {
    calls.push(['openFile', wireId]);
    return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
  },
};

try {
  const pinPath = join(root, 'workspace');
  const pinRequest = { jsonrpc: '2.0', id: 6, method: 'tools/call',
    params: { name: 'define_local_identity_file', arguments: { name: ' Agent ', path: pinPath } } };
  const pinIntent = { name: ' Agent ', path: pinPath, force: false,
    expose_local: true, local_auto_accept: true, overwrite: false };
  const pinResponse = { jsonrpc: '2.0', id: 6, result: {
    content: [], isError: false, structuredContent: { oursHostIdentityFile: pinIntent },
  } };
  const pin = await completeHostFileCall(client, pinRequest, pinResponse);
  assert.equal(pin.result.isError, false);
  const pinFile = join(pinPath, '.ours-identity');
  assert.deepEqual(JSON.parse(readFileSync(pinFile, 'utf8')),
    { identity: 'Agent', expose_local: true, local_auto_accept: true });
  assert.match(pin.result.content[0].text, /^Wrote /);
  assert.equal((await completeHostFileCall(client, pinRequest, pinResponse)).result.isError, true,
    'existing pins are not overwritten by default');
  const replacementArgs = { name: 'Next', path: pinFile, overwrite: true, force: true, expose_local: false };
  const replacement = await completeHostFileCall(client,
    { ...pinRequest, params: { ...pinRequest.params, arguments: replacementArgs } },
    { ...pinResponse, result: { ...pinResponse.result, structuredContent: { oursHostIdentityFile: {
      ...replacementArgs, local_auto_accept: true,
    } } } });
  assert.equal(replacement.result.isError, false);
  assert.deepEqual(JSON.parse(readFileSync(pinFile, 'utf8')),
    { identity: 'Next', force: true, expose_local: false, local_auto_accept: true });
  await assert.rejects(completeHostFileCall(client, pinRequest,
    { ...pinResponse, result: { ...pinResponse.result, structuredContent: {
      oursHostIdentityFile: { ...pinIntent, path: join(root, 'wrong-target') },
    } } }), /mismatched/);
  await assert.rejects(completeHostFileCall(client,
    { ...pinRequest, params: { ...pinRequest.params, arguments: { ...pinRequest.params.arguments, path: 'relative' } } },
    { ...pinResponse, result: { ...pinResponse.result, structuredContent: {
      oursHostIdentityFile: { ...pinIntent, path: 'relative' },
    } } }), /invalid/);
  const request = {
    jsonrpc: '2.0', id: 7, method: 'tools/call',
    params: { name: 'send_file', _meta: { threadId: 'thread-1' }, arguments: { contact: 'Peer', path: source } },
  };
  const prepared = await prepareHostFileCall(client, request);
  assert.deepEqual(prepared, {
    jsonrpc: '2.0', id: 7, method: 'tools/call',
    params: {
      name: 'send_file', _meta: { threadId: 'thread-1' },
      arguments: { contact: 'Peer', upload_id: 'staged-1', filename: 'source.bin' },
    },
  });
  assert.deepEqual(calls[0], ['uploadFile', bytes, { filename: 'source.bin', mime: undefined, size: bytes.length }]);

  const saveRequest = {
    jsonrpc: '2.0', id: 8, method: 'tools/call',
    params: { name: 'save_file', arguments: { wire_id: 'abc123', dest_path: destination } },
  };
  const intermediate = {
    jsonrpc: '2.0', id: 8,
    result: {
      content: [{ type: 'text', text: 'Host save requested for wire_id abc123.' }],
      structuredContent: { oursHostSave: { wire_id: 'abc123', dest_path: destination } },
      isError: false,
    },
  };
  const completed = await completeHostFileCall(client, saveRequest, intermediate);
  assert.deepEqual(readFileSync(destination), bytes);
  assert.deepEqual(calls.at(-1), ['openFile', 'abc123']);
  assert.equal(completed.result.isError, false);
  assert.match(completed.result.content[0].text, /Saved file \(wire_id abc123\).*\(5 bytes\)/);
  assert.equal(Object.hasOwn(completed.result, 'structuredContent'), false,
    'the intermediate server intent is never exposed as final success');

  const uploadController = new AbortController();
  let uploadStarted;
  let mutationReached = false;
  const slowSource = join(root, 'slow-source.bin');
  writeFileSync(slowSource, Buffer.alloc(1024 * 1024, 7));
  const slowRequest = {
    ...request,
    params: { ...request.params, arguments: { ...request.params.arguments, path: slowSource } },
  };
  const slowUploadClient = {
    uploadFile: async (stream) => {
      const reader = stream.getReader();
      await reader.read();
      uploadStarted();
      await new Promise((resolve) => setTimeout(resolve, 50));
      await reader.read();
      mutationReached = true;
      return { upload_id: 'must-not-complete' };
    },
  };
  const started = new Promise((resolve) => { uploadStarted = resolve; });
  const cancelledUpload = prepareHostFileCall(slowUploadClient, slowRequest, uploadController.signal);
  await started;
  uploadController.abort(new Error('cancel upload'));
  await assert.rejects(cancelledUpload, /cancel upload/);
  assert.equal(mutationReached, false);

  const downloadController = new AbortController();
  const cancelledDownload = completeHostFileCall({
    openFile: async () => new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from('partial'));
        setTimeout(() => {
          try { controller.enqueue(Buffer.from('must-not-write')); } catch { /* cancellation closed it */ }
        }, 50);
      },
    }),
  }, saveRequest, { ...intermediate, result: { ...intermediate.result } }, downloadController.signal);
  setTimeout(() => downloadController.abort(new Error('cancel download')), 10);
  await assert.rejects(cancelledDownload, /cancel download/);

  const record = nativeSessionRecordPath(
    root,
    'b282ca8e-72d2-48cc-a948-b3c1a62129f5',
    'native/thread/selector',
  );
  assert.match(record, new RegExp(`^${root}/sessions/b282ca8e-72d2-48cc-a948-b3c1a62129f5/[0-9a-f]{64}\\.json$`),
    'native records live under the explicit host-private root');
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('host-client: streamed file adapters and explicit native record root verified');
