import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validatePlatform, appServerArgs, remoteTuiArgs, launcherEnvironment, liveProcessEnvironments, sessionEndPayload, sessionRegistrationFromNotification } from '../src/launcher.mjs';

for (const [scenario, code] of [
  ['fast', 0], ['nonzero', 7], ['signal', 128],
  ['cleanup-error', 0], ['cleanup-signal', 0], ['startup-error', 1], ['hung', 0],
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
    if (scenario === 'cleanup-error') assert.match(child.stderr, /SessionEnd cleanup failed: spawn error/);
    if (scenario === 'cleanup-signal') assert.match(child.stderr, /SessionEnd cleanup failed: signal SIGTERM/);
    if (scenario === 'hung') assert.match(child.stderr, /SessionEnd cleanup failed: timed out/);
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

test('propagates explicit profile without snapshotting credentials or local ownership', () => {
  const inherited = { PATH: '/bin', OURS_PORT: '9999', OURS_API_TOKEN: 'stale', OURS_STATE_DIR: '/stale', OURS_CLIENT_PID: '42', OURS_AUTOSTART: '1' };
  const profile = { profile: { endpoint: 'http://127.0.0.1:4050', expectedInstanceId: '12345678-1234-1234-1234-123456789abc', credentialPath: '/host/token' }, configPath: '/tmp/ours.json' };
  const env = launcherEnvironment(inherited, profile, { socketPath: '/tmp/control.sock', capability: 'cap' });
  assert.equal(env.OURS_CONFIG, '/tmp/ours.json');
  for (const key of ['OURS_PORT', 'OURS_API_TOKEN', 'OURS_STATE_DIR', 'OURS_CLIENT_PID', 'OURS_AUTOSTART']) assert.equal(key in env, false, key);
  assert.equal(env.PATH, '/bin');
  assert.equal(env.OURS_CODEX_CONTROL_SOCKET, '/tmp/control.sock');
  assert.equal(env.OURS_CODEX_CAPABILITY, 'cap');
});

test('propagates exact legacy selection and private control channel', () => {
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

test('native profile cleanup forwards the retained thread ID as SessionEnd JSON', () => {
  const profile = { profile: { endpoint: 'http://127.0.0.1:4050', expectedInstanceId: '12345678-1234-1234-1234-123456789abc', credentialPath: '/host/token' } };
  assert.equal(sessionEndPayload(profile, { threadId: 'thr-native' }), '{"session_id":"thr-native"}\n');
  assert.equal(sessionEndPayload(profile, { threadId: null }), null);
  assert.equal(sessionEndPayload({ port: 4050 }, { threadId: 'legacy' }), null);
});
