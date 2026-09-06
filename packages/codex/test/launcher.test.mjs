import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { validatePlatform, appServerArgs, remoteTuiArgs, launcherEnvironment, liveProcessEnvironments, sessionRegistrationFromNotification } from '../src/launcher.mjs';

test('successful cleanup lets the launcher process exit without waiting for its deadline', () => {
  const launcherUrl = new URL('../src/launcher.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { EventEmitter } from 'node:events';
    import { tmpdir } from 'node:os';
    import { runLauncher } from ${JSON.stringify(launcherUrl)};
    process.exitCode = await runLauncher({
      argv: [], env: { XDG_RUNTIME_DIR: tmpdir() },
      profileResolver: async () => ({ port: 1, baseUrl: 'http://127.0.0.1:1', configPath: '/nonexistent', codexArgs: [] }),
      fetch: async () => ({ ok: true }),
      connect: async () => ({ onServerRequest() {}, onNotification() {}, close() {} }),
      spawn: (_command, args) => {
        const child = new EventEmitter();
        child.exitCode = null;
        child.kill = () => { child.exitCode = 0; child.emit('exit', 0, null); };
        if (args[0] !== 'app-server') setImmediate(() => child.kill());
        return child;
      },
    });
    console.log('launcher returned');
  `], { encoding: 'utf8', timeout: 5_000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'launcher returned');
});

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
