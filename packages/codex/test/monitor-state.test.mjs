import test from 'node:test';
import assert from 'node:assert/strict';
import { createMonitorState, registerSession, bindingChanged, arm, disarm, notificationArrived, turnStarted, turnCompleted } from '../src/monitor-state.mjs';

test('monitor requires explicit arm and disarms on identity change', () => {
  let state = createMonitorState();
  ({ state } = registerSession(state, { sessionId: 's', threadId: 't', cwd: '/tmp' }));
  ({ state } = bindingChanged(state, 'Alice'));
  assert.equal(notificationArrived(state, '1').effects.length, 0);
  let result = arm(state, 'Alice'); state = result.state;
  assert.deepEqual(result.effects, [{ type: 'subscribe', identity: 'Alice' }]);
  result = bindingChanged(state, 'Bob'); state = result.state;
  assert.equal(state.armedIdentity, null);
  assert.deepEqual(result.effects, [{ type: 'unsubscribe', identity: 'Alice' }]);
});

test('explicit arm consent claims an unset binding but never overwrites another binding', () => {
  const claimed = arm(createMonitorState(), 'Alice');
  assert.equal(claimed.state.boundIdentity, 'Alice');
  assert.equal(claimed.state.armedIdentity, 'Alice');
  assert.throws(() => arm(bindingChanged(createMonitorState(), 'Bob').state, 'Alice'), /current binding is Bob/);
});

test('coalesces notifications and queues while a turn is active', () => {
  let state = { ...createMonitorState(), sessionId: 's', threadId: 't', boundIdentity: 'Alice', armedIdentity: 'Alice' };
  let result = notificationArrived(state, '10'); state = result.state;
  assert.deepEqual(result.effects, [{ type: 'startWakeTurn' }]);
  assert.equal(notificationArrived(state, '11').effects.length, 0);
  ({ state } = turnStarted(state));
  result = notificationArrived(state, '12'); state = result.state;
  assert.equal(result.effects.length, 0);
  result = turnCompleted(state); state = result.state;
  assert.deepEqual(result.effects, [{ type: 'startWakeTurn' }]);
  assert.equal(state.pendingWake, true);
  result = disarm(state);
  assert.equal(result.state.pendingWake, false);
});
