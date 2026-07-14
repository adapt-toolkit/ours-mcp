import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { AppServerClient } from '../src/app-server-client.mjs';

class FakeTransport extends EventEmitter {
  sent = [];
  send(value) { this.sent.push(value); }
  close() { this.emit('close'); }
  receive(value) { this.emit('message', value); }
}

test('initializes, correlates requests, and uses v2 helpers', async () => {
  const transport = new FakeTransport();
  const client = new AppServerClient(transport, { timeoutMs: 100 });
  const init = client.initialize();
  assert.equal(transport.sent[0].method, 'initialize');
  transport.receive({ id: transport.sent[0].id, result: { userAgent: 'test' } });
  await init;
  assert.equal(transport.sent[1].method, 'initialized');

  const list = client.listThreads('/repo');
  assert.deepEqual(transport.sent.at(-1).params, { cwd: '/repo' });
  transport.receive({ id: transport.sent.at(-1).id, result: { data: [] } });
  await list;
  const read = client.readThread('thr');
  assert.deepEqual(transport.sent.at(-1).params, { threadId: 'thr', includeTurns: true });
  transport.receive({ id: transport.sent.at(-1).id, result: { thread: { id: 'thr' } } });
  await read;
  const turn = client.startTurn('thr', 'fixed text');
  assert.deepEqual(transport.sent.at(-1).params, { threadId: 'thr', input: [{ type: 'text', text: 'fixed text' }] });
  transport.receive({ id: transport.sent.at(-1).id, result: { turn: { id: 'turn' } } });
  await turn;
});

test('delivers notifications, surfaces server requests, times out and rejects on close', async () => {
  const transport = new FakeTransport();
  const client = new AppServerClient(transport, { timeoutMs: 15 });
  const notifications = [];
  client.onNotification((m) => notifications.push(m));
  client.onServerRequest(async () => ({ decision: 'decline' }));
  transport.receive({ method: 'turn/started', params: { turn: { id: 'x' } } });
  transport.receive({ id: 99, method: 'item/commandExecution/requestApproval', params: {} });
  await new Promise((r) => setImmediate(r));
  assert.equal(notifications[0].method, 'turn/started');
  assert.deepEqual(transport.sent.at(-1), { id: 99, result: { decision: 'decline' } });
  await assert.rejects(client.request('thread/list', {}), /timed out/);
  const pending = client.request('thread/list', {});
  transport.close();
  await assert.rejects(pending, /closed/);
});
