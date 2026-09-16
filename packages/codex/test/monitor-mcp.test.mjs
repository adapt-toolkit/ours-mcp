import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  monitorToolNames, foregroundWatchProcess, handleMonitorCommand, waitForForegroundMail,
} from '../dist/monitor-mcp.mjs';

test('exposes background and foreground monitor tools', () => {
  assert.deepEqual(monitorToolNames, ['arm_monitor', 'foreground_monitor', 'disarm_monitor', 'monitor_status']);
  const watch = foregroundWatchProcess('Alice', undefined, {});
  assert.deepEqual(watch.args.slice(-2), ['watch', 'Alice']);
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
  const waiting = waitForForegroundMail('Alice', 'thread-a', {
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
  const waiting = waitForForegroundMail('Alice', 'thread-a', { spawnImpl: () => child, signal: controller.signal });
  controller.abort();
  await assert.rejects(waiting, /stopped/);
  assert.equal(child.killed, true);
});

test('foreground watch uses the package-local network client for a selected host profile', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'ours-watch-container-'));
  try {
    const profile = join(dir, 'profile.json');
    writeFileSync(profile, JSON.stringify({
      endpoint: 'http://127.0.0.1:4050',
      expectedInstanceId: 'b282ca8e-72d2-48cc-a948-b3c1a62129f5',
      credentialPath: join(dir, 'credential'),
    }), { mode: 0o600 });
    const invocation = foregroundWatchProcess('Alice', 'thread-a', { OURS_CONFIG: profile });
    assert.equal(invocation.command, process.execPath);
    assert.match(invocation.args[0], /bin\/network-watch\.mjs$/);
    assert.deepEqual(invocation.args.slice(1), ['Alice', 'thread-a']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('selected host foreground watch rejects missing native session metadata', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'ours-watch-session-'));
  try {
    const profile = join(dir, 'profile.json');
    writeFileSync(profile, JSON.stringify({ endpoint: 'http://127.0.0.1:4050', expectedInstanceId: 'b282ca8e-72d2-48cc-a948-b3c1a62129f5', credentialPath: join(dir, 'credential') }), { mode: 0o600 });
    assert.throws(() => foregroundWatchProcess('Alice', undefined, { OURS_CONFIG: profile }), /Native session metadata/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
