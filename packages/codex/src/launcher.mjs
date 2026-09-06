import { spawn as nodeSpawn } from 'node:child_process';
import { createServer } from 'node:net';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { resolveDaemonProfile } from './profile.mjs';
import { connectAppServer } from './app-server-client.mjs';
import { AtomicStateStore, ControlServer } from './control-server.mjs';
import { MonitorWatcher } from './watcher.mjs';

export function validatePlatform(platform = process.platform) {
  if (platform === 'win32') throw new Error('native Windows is not supported in ours-codex v1; run it inside WSL');
}
export const appServerArgs = (url, codexArgs = []) => [
  ...(codexArgs.includes('--dangerously-bypass-hook-trust') ? ['--dangerously-bypass-hook-trust'] : []),
  'app-server', '--listen', url,
];
export const remoteTuiArgs = (url, codexArgs) => ['--remote', url, ...codexArgs];

export function launcherEnvironment(env, profile, control) {
  const out = {
    ...env,
    OURS_PORT: String(profile.port),
    OURS_CONFIG: profile.configPath,
    OURS_AUTOSTART: '0',
    OURS_CODEX_CONTROL_SOCKET: control.socketPath,
    OURS_CODEX_CAPABILITY: control.capability,
    OURS_CODEX_LIVE: '1',
    // One stable owner pid for the MCP proxy, hooks, and launcher's own cleanup
    // call. The bin shim preserves an explicit value instead of replacing it
    // with whichever child happened to spawn it.
    OURS_CLIENT_PID: String(process.pid),
  };
  if (profile.token) out.OURS_API_TOKEN = profile.token;
  else delete out.OURS_API_TOKEN;
  return out;
}

export function liveProcessEnvironments(env, profile, control) {
  const live = launcherEnvironment(env, profile, control);
  return { appServer: live, tui: live };
}

export function sessionRegistrationFromNotification(message, cwd) {
  const threadId = message?.method === 'thread/started' ? message.params?.thread?.id
    : message?.method === 'turn/started' ? (message.params?.threadId || message.params?.thread?.id)
      : null;
  return typeof threadId === 'string' && threadId
    ? { command: 'register_session', sessionId: threadId, threadId, cwd }
    : null;
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitReady(url, fetchImpl, child) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Codex App Server exited early (${child.exitCode})`);
    try { if ((await fetchImpl(`${url.replace(/^ws/, 'http')}/readyz`)).ok) return; } catch { /* startup */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Codex App Server did not become ready');
}

function waitExit(child) {
  if (child.exitCode != null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return once(child, 'exit').then(([code, signal]) => ({ code, signal }));
}

export async function runLauncher({
  argv = process.argv.slice(2), env = process.env, platform = process.platform,
  spawn = nodeSpawn, fetch: fetchImpl = globalThis.fetch,
  profileResolver = resolveDaemonProfile, connect = connectAppServer,
} = {}) {
  validatePlatform(platform);
  const profile = await profileResolver({ argv, env, fetch: fetchImpl });
  const runtimeBase = env.XDG_RUNTIME_DIR || tmpdir();
  const runtimeDir = await mkdtemp(join(runtimeBase, 'ours-codex-'));
  await chmod(runtimeDir, 0o700);
  const socketPath = join(runtimeDir, 'control.sock');
  const capability = randomBytes(32).toString('hex');
  const url = `ws://127.0.0.1:${await freePort()}`;
  const processEnvs = liveProcessEnvironments(env, profile, { socketPath, capability });
  let appServer;
  let tui;
  let client;
  let control;
  let watcher;
  const sessionEndShim = join(dirname(dirname(fileURLToPath(import.meta.url))), 'bin', 'proxy.mjs');
  const cleanup = async () => {
    watcher?.stop();
    await control?.close().catch(() => {});
    client?.close();
    // The TUI exit is an authoritative normal session end. Run the same lease
    // DELETE seam as the native hook while the shared daemon is still reachable;
    // duplicate hook+launcher cleanup is intentionally idempotent.
    const end = spawn(process.execPath, [sessionEndShim, 'session-end'], {
      env: processEnvs.appServer,
      stdio: 'ignore',
    });
    end.once('error', () => {});
    let cleanupDeadline;
    await Promise.race([
      waitExit(end),
      new Promise((resolve) => { cleanupDeadline = setTimeout(resolve, 30_000); }),
    ]).catch(() => {}).finally(() => clearTimeout(cleanupDeadline));
    if (end.exitCode == null) end.kill('SIGTERM');
    if (tui && tui.exitCode == null) tui.kill('SIGTERM');
    if (appServer && appServer.exitCode == null) appServer.kill('SIGTERM');
    await rm(runtimeDir, { recursive: true, force: true });
  };
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const handlers = new Map();
  try {
    appServer = spawn('codex', appServerArgs(url, profile.codexArgs), { env: processEnvs.appServer, stdio: ['ignore', 'ignore', 'inherit'] });
    appServer.once('error', () => {});
    await waitReady(url, fetchImpl, appServer);
    client = await connect(url, { timeoutMs: 30_000 });
    client.onServerRequest((message) => {
      if (message.method.includes('requestApproval')) return { decision: 'decline' };
      throw new Error(`ours monitor cannot answer ${message.method}`);
    });
    watcher = new MonitorWatcher({
      baseUrl: profile.baseUrl, token: profile.token, fetch: fetchImpl, appServer: client,
      stateStore: new AtomicStateStore(join(runtimeDir, 'cursor.json')),
    });
    control = new ControlServer({
      socketPath, capability, stateStore: new AtomicStateStore(join(runtimeDir, 'state.json')),
      onEffects: async (effects, state) => {
        for (const effect of effects) {
          if (effect.type === 'unsubscribe') watcher.stop();
          if (effect.type === 'subscribe') {
            if (!state.threadId) throw new Error('Codex session has not registered its thread yet');
            void watcher.start({ identity: effect.identity, threadId: state.threadId, cursor: state.cursor }).catch(() => {});
          }
        }
      },
    });
    await control.start();
    client.onNotification((message) => {
      const registration = sessionRegistrationFromNotification(message, profile.cwd || process.cwd());
      if (registration) void control.apply(registration);
    });
    tui = spawn('codex', remoteTuiArgs(url, profile.codexArgs), { env: processEnvs.tui, stdio: 'inherit' });
    for (const signal of signals) {
      const handler = () => { if (tui?.exitCode == null) tui.kill(signal); };
      handlers.set(signal, handler); process.on(signal, handler);
    }
    const outcome = await waitExit(tui);
    return outcome.signal ? 128 : (outcome.code ?? 0);
  } catch (error) {
    throw new Error(`${error.message}\nStandard mode remains available with: codex`);
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    await cleanup();
  }
}
