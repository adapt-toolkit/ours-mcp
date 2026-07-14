import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePlatform, appServerArgs, remoteTuiArgs, launcherEnvironment } from '../src/launcher.mjs';

test('supports Unix hosts but rejects native Windows v1', () => {
  assert.doesNotThrow(() => validatePlatform('linux'));
  assert.doesNotThrow(() => validatePlatform('darwin'));
  assert.throws(() => validatePlatform('win32'), /not supported.*WSL/i);
});

test('constructs only app-server and remote TUI commands', () => {
  assert.deepEqual(appServerArgs('ws://127.0.0.1:4512'), ['app-server', '--listen', 'ws://127.0.0.1:4512']);
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
});
