import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createOursMcpServer } from '../dist/server.js';

const wireId = 'A'.repeat(64);
const calls = [];
const receivedFile = {
  wire_id: wireId,
  status: 'saved',
  path: '/daemon/private/blobs/file.bin',
  filename: 'file.bin',
  mime: 'application/octet-stream',
  size: 4,
  kind: 'file',
};
const fakeClient = {
  listIdentities: async () => identityRows,
  currentIdentity: async () => ({ name: 'Agent' }),
  sendFile: async (input) => {
    calls.push(['sendFile', input]);
    return {
      kind: 'sent', wireId, wire_id: wireId, filename: 'file.bin', bytes: 4,
      mime: 'application/octet-stream', history_stored: true,
    };
  },
  getFiles: async (input) => {
    calls.push(['getFiles', input]);
    return { files: [receivedFile], text: 'Received file.bin.', mode: 'selected', requested: [wireId], remaining: 0 };
  },
  openFile: async () => { throw new Error('the server must not write a host destination in network mode'); },
};
const applicationIdentities = { list: async () => ['Agent', 'Reviewer'] };
let identityRows = [];

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const server = createOursMcpServer(fakeClient, 'test', applicationIdentities, { networkHostFiles: true });
const client = new Client({ name: 'network-mode-test', version: '1' }, { capabilities: {} });
await server.connect(serverTransport);
await client.connect(clientTransport);

try {
  const pin = await client.callTool({ name: 'define_local_identity_file', arguments: { name: 'Agent', path: '/host/project' } });
  assert.equal(pin.isError, false, 'network pin must not call the daemon filesystem API');
  assert.deepEqual(pin.structuredContent.oursHostIdentityFile, {
    name: 'Agent', path: '/host/project', force: false,
    expose_local: true, local_auto_accept: true, overwrite: false,
  });
  assert.doesNotMatch(pin.content[0].text, /^Wrote/);
  const relativePin = await client.callTool({ name: 'define_local_identity_file', arguments: { name: 'Agent', path: 'relative' } });
  assert.equal(relativePin.isError, true);
  const hiddenRoot = { name: 'HiddenHuman', cid: 'B'.repeat(64), kind: 'root', session: null, temp: null };
  const agent = { name: 'Agent', cid: 'C'.repeat(64), kind: 'role', session: 'mine', temp: null };
  const listText = async () => {
    const result = await client.callTool({ name: 'list_identities', arguments: {} });
    assert.equal(result.isError, false);
    return result.content[0].text;
  };
  identityRows = [hiddenRoot, agent];
  const visibleRole = await listText();
  assert.match(visibleRole, /Agent.*role/);
  assert.doesNotMatch(visibleRole, /HiddenHuman|no root|create_root_identity/,
    'a filtered-out root must not trigger false onboarding or leak into the view');
  identityRows = [hiddenRoot];
  const emptyView = await listText();
  assert.match(emptyView, /application/i);
  assert.doesNotMatch(emptyView, /No identities yet|HiddenHuman|create_root_identity/);
  identityRows = [{ name: 'HiddenQuarantined', status: 'awaiting-root' }];
  assert.doesNotMatch(await listText(), /No identities yet/,
    'quarantined rows are existing daemon state, even outside the application view');
  identityRows = [{ name: 'Agent', status: 'awaiting-root' }];
  const quarantined = await listText();
  assert.match(quarantined, /quarantined.*unavailable for binding/);
  assert.match(quarantined, /no root identity yet/);
  identityRows = [];
  assert.match(await listText(), /No identities yet.*create_root_identity/,
    'a genuinely empty daemon retains initial setup guidance');

  const resource = await client.readResource({ uri: 'ours://application-identities' });
  assert.equal(resource.contents.length, 1);
  assert.equal(resource.contents[0].mimeType, 'application/json');
  assert.deepEqual(JSON.parse(resource.contents[0].text), { identities: ['Agent', 'Reviewer'] });

  const sent = await client.callTool({
    name: 'send_file',
    arguments: { contact: 'Peer', upload_id: 'staged-upload', filename: 'file.bin', mime: 'application/octet-stream' },
  });
  assert.equal(sent.isError, false);
  assert.deepEqual(calls.at(-1), ['sendFile', {
    contact: 'Peer', upload_id: 'staged-upload', filename: 'file.bin', mime: 'application/octet-stream',
    reply_to_wire_id: undefined, reply_to_sentence: undefined,
  }], 'network send_file consumes only bytes staged by the host bridge');

  const files = await client.callTool({ name: 'get_files', arguments: { wire_ids: [wireId] } });
  assert.equal(files.isError, false);
  assert.equal(files.structuredContent.files[0].readable, false,
    'daemon blob paths are explicitly inaccessible to network clients');

  const destination = '/host/chosen/file.bin';
  const saved = await client.callTool({
    name: 'save_file', arguments: { wire_id: wireId, dest_path: destination },
  });
  assert.equal(saved.isError, false);
  assert.deepEqual(saved.structuredContent, {
    oursHostSave: { wire_id: wireId, dest_path: destination },
  });
  assert.doesNotMatch(saved.content[0].text, /Saved file/,
    'the server does not claim a host write completed before the bridge writes it');
} finally {
  await client.close();
  await server.close();
}

console.log('network-server: application resource and host file intents verified');
