import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { monitorToolNames, handleMonitorCommand, waitForForegroundMail } from '../src/monitor-mcp.mjs';

test('exposes background and foreground monitor tools', () => {
  assert.deepEqual(monitorToolNames, ['arm_monitor', 'foreground_monitor', 'disarm_monitor', 'monitor_status']);
});

test('standard mode is informative and live mode uses private control channel', async () => {
  const standard = await handleMonitorCommand('arm', { identity: 'Alice' }, { env: {} });
  assert.equal(standard.mode, 'foreground-offer');
  assert.match(standard.text, /standard `codex` session only supports a blocking foreground monitor/i);
  assert.match(standard.text, /For background monitoring, restart the session with `ours-codex` instead/i);
  assert.match(standard.text, /tell the user exactly/i);
  assert.match(standard.text, /Do you want to arm the foreground blocking monitor here/i);
  assert.match(standard.text, /explicit yes/i);
  const calls = [];
  const live = await handleMonitorCommand('arm', { identity: 'Alice' }, {
    env: { OURS_CODEX_CONTROL_SOCKET: '/tmp/s', OURS_CODEX_CAPABILITY: 'cap' },
    send: async (...args) => { calls.push(args); return { state: { boundIdentity: 'Alice', armedIdentity: 'Alice' } }; },
  });
  assert.deepEqual(calls[0], ['/tmp/s', 'cap', { command: 'arm', identity: 'Alice' }]);
  assert.match(live.text, /armed/i);
});

test('foreground monitor returns the first body-free watch event and stops the watcher', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = (signal) => { child.killed = true; child.killSignal = signal; return true; };
  const calls = [];
  const waiting = waitForForegroundMail('Alice', {
    env: { OURS_PORT: '4050' },
    commandFor: (identity) => ({ command: 'ours-mcp', args: ['watch', identity] }),
    spawnImpl: (...args) => { calls.push(args); return child; },
  });
  child.stdout.write('[Alice] new message from Bob (#7)\n');
  assert.equal(await waiting, '[Alice] new message from Bob (#7)');
  assert.deepEqual(calls[0], ['ours-mcp', ['watch', 'Alice'], {
    env: { OURS_PORT: '4050' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }]);
  assert.equal(child.killSignal, 'SIGTERM');
});

test('foreground monitor can be interrupted', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; return true; };
  const controller = new AbortController();
  const waiting = waitForForegroundMail('Alice', { spawnImpl: () => child, signal: controller.signal });
  controller.abort();
  await assert.rejects(waiting, /stopped/);
  assert.equal(child.killed, true);
});
