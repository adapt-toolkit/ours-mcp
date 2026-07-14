import test from 'node:test';
import assert from 'node:assert/strict';
import { monitorToolNames, handleMonitorCommand } from '../src/monitor-mcp.mjs';

test('exposes explicit arm, disarm and status tools', () => {
  assert.deepEqual(monitorToolNames, ['arm_monitor', 'disarm_monitor', 'monitor_status']);
});

test('standard mode is informative and live mode uses private control channel', async () => {
  const standard = await handleMonitorCommand('status', {}, { env: {} });
  assert.match(standard.text, /ours-codex.*live mode/i);
  const calls = [];
  const live = await handleMonitorCommand('arm', { identity: 'Alice' }, {
    env: { OURS_CODEX_CONTROL_SOCKET: '/tmp/s', OURS_CODEX_CAPABILITY: 'cap' },
    send: async (...args) => { calls.push(args); return { state: { boundIdentity: 'Alice', armedIdentity: 'Alice' } }; },
  });
  assert.deepEqual(calls[0], ['/tmp/s', 'cap', { command: 'arm', identity: 'Alice' }]);
  assert.match(live.text, /armed/i);
});

