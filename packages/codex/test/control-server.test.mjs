import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlServer, sendControlCommand } from '../src/control-server.mjs';

test('private socket authenticates, routes state, and cleans up', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ours-control-'));
  const socketPath = join(dir, 'control.sock');
  const seen = [];
  const server = new ControlServer({ socketPath, capability: 'secret', onEffects: async (effects, state) => seen.push([effects, state]) });
  await server.start();
  assert.equal((await stat(dir)).mode & 0o077, 0);
  await assert.rejects(() => sendControlCommand(socketPath, 'wrong', { command: 'status' }), /capability/);
  await sendControlCommand(socketPath, 'secret', { command: 'register_session', sessionId: 's', threadId: 't', cwd: '/tmp' });
  await sendControlCommand(socketPath, 'secret', { command: 'binding_changed', identity: 'Alice' });
  const armed = await sendControlCommand(socketPath, 'secret', { command: 'arm', identity: 'Alice' });
  assert.equal(armed.state.armedIdentity, 'Alice');
  const status = await sendControlCommand(socketPath, 'secret', { command: 'status' });
  assert.equal(status.state.threadId, 't');
  assert.equal(seen.find(([effects]) => effects[0]?.type === 'subscribe')[0][0].type, 'subscribe');
  await server.close();
  await assert.rejects(stat(socketPath));
});
