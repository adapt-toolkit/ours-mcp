import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeControlLine, encodeControlResponse } from '../src/control-protocol.mjs';

test('accepts authenticated control commands', () => {
  for (const command of ['register_session', 'binding_changed', 'arm', 'disarm', 'status']) {
    const msg = { capability: 'secret', command };
    if (command === 'register_session') Object.assign(msg, { sessionId: 's', threadId: 't', cwd: '/tmp' });
    if (command === 'binding_changed' || command === 'arm') msg.identity = 'Alice';
    assert.equal(decodeControlLine(JSON.stringify(msg), 'secret').command, command);
  }
  assert.equal(encodeControlResponse({ ok: true }), '{"ok":true}\n');
});

test('rejects unauthenticated, malformed, unknown and oversized messages', () => {
  assert.throws(() => decodeControlLine('{}', 'secret'), /capability/);
  assert.throws(() => decodeControlLine('{', 'secret'), /valid JSON/);
  assert.throws(() => decodeControlLine(JSON.stringify({ capability: 'secret', command: 'erase' }), 'secret'), /unknown command/);
  assert.throws(() => decodeControlLine(JSON.stringify({ capability: 'secret', command: 'arm', identity: '' }), 'secret'), /identity/);
  assert.throws(() => decodeControlLine(' '.repeat(65537), 'secret'), /too large/);
});
