import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validatePlatform, appServerArgs, remoteTuiArgs, launcherEnvironment, liveProcessEnvironments, sessionRegistrationFromNotification } from '../src/launcher.mjs';

for (const [scenario, code] of [
  ['fast', 0], ['nonzero', 7], ['signal', 128],
  ['cleanup-error', 0], ['startup-error', 1], ['hung', 0],
]) {
  test(`launcher exits naturally after ${scenario} cleanup`, () => {
    const child = spawnSync(process.execPath, [
      fileURLToPath(new URL('../test-support/launcher-process.mjs', import.meta.url)), scenario,
    ], { encoding: 'utf8', timeout: 5_000 });
    assert.ifError(child.error);
    assert.equal(child.signal, null, child.stderr);
    assert.equal(child.status, code, child.stderr);
    // Written at process exit, so a timer firing AFTER runLauncher resolves is visible.
    const report = JSON.parse(child.stdout);
    assert.equal(report.settled, true);
    assert.equal(report.deadlines, 1);
    assert.equal(report.referenced, true, 'hung cleanup must keep its deadline alive');
    assert.equal(report.fired, scenario === 'hung');
    assert.equal(report.firedAfterSettled, scenario === 'hung' ? false : null);
    assert.equal(report.cleared, true, 'release the deadline on every race outcome');
    assert.deepEqual(report.kills, scenario === 'hung' || scenario === 'cleanup-error'
      ? [['end', 'SIGTERM'], ['app-server', 'SIGTERM']]
      : scenario === 'signal' ? [['tui', 'SIGTERM'], ['app-server', 'SIGTERM']]
      : [['app-server', 'SIGTERM']]);
    if (scenario === 'startup-error') {
      assert.equal(report.error, 'connect failed\nStandard mode remains available with: codex');
    } else {
      assert.equal(report.result, code);
    }
  });
}

test('supports Unix hosts but rejects native Windows v1', () => {
  assert.doesNotThrow(() => validatePlatform('linux'));
  assert.doesNotThrow(() => validatePlatform('darwin'));
  assert.throws(() => validatePlatform('win32'), /not supported.*WSL/i);
});

test('constructs only app-server and remote TUI commands', () => {
  assert.deepEqual(appServerArgs('ws://127.0.0.1:4512'), ['app-server', '--listen', 'ws://127.0.0.1:4512']);
  assert.deepEqual(
    appServerArgs('ws://127.0.0.1:4512', ['--dangerously-bypass-hook-trust', '--model', 'gpt-5']),
    ['--dangerously-bypass-hook-trust', 'app-server', '--listen', 'ws://127.0.0.1:4512'],
  );
  assert.deepEqual(remoteTuiArgs('ws://127.0.0.1:4512', ['--model', 'gpt-5']), ['--remote', 'ws://127.0.0.1:4512', '--model', 'gpt-5']);
  assert.doesNotMatch(JSON.stringify([appServerArgs('x'), remoteTuiArgs('x', [])]), /ours-mcp.*(start|stop|restart)/);
});

test('propagates exact selected profile and private control channel', () => {
  const env = launcherEnvironment({ PATH: '/bin' }, { port: 4050, token: 'tok', configPath: '/tmp/ours.json' }, { socketPath: '/tmp/control.sock', capability: 'cap' });
  assert.equal(env.OURS_PORT, '4050');
  assert.equal(env.OURS_API_TOKEN, 'tok');
  assert.equal(env.OURS_CONFIG, '/tmp/ours.json');
  assert.equal(env.OURS_AUTOSTART, '0');
  assert.equal(env.OURS_CODEX_CONTROL_SOCKET, '/tmp/control.sock');
  assert.equal(env.OURS_CODEX_CAPABILITY, 'cap');
  assert.equal(env.OURS_CLIENT_PID, String(process.pid));
});

test('passes the live control environment to both App Server and remote TUI', () => {
  const envs = liveProcessEnvironments({ PATH: '/bin' }, { port: 4050, token: 'tok', configPath: '/tmp/ours.json' }, { socketPath: '/tmp/control.sock', capability: 'cap' });
  assert.equal(envs.appServer.OURS_CODEX_LIVE, '1');
  assert.equal(envs.appServer.OURS_CODEX_CONTROL_SOCKET, '/tmp/control.sock');
  assert.equal(envs.appServer.OURS_PORT, '4050');
  assert.strictEqual(envs.tui, envs.appServer);
});

test('derives session registration from App Server thread notifications', () => {
  assert.deepEqual(sessionRegistrationFromNotification({ method: 'thread/started', params: { thread: { id: 'thr-1' } } }, '/repo'), {
    command: 'register_session', sessionId: 'thr-1', threadId: 'thr-1', cwd: '/repo',
  });
  assert.deepEqual(sessionRegistrationFromNotification({ method: 'turn/started', params: { threadId: 'thr-2' } }, '/repo'), {
    command: 'register_session', sessionId: 'thr-2', threadId: 'thr-2', cwd: '/repo',
  });
  assert.equal(sessionRegistrationFromNotification({ method: 'item/started', params: {} }, '/repo'), null);
});
