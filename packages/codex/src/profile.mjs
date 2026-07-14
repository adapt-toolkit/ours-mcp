import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const DEFAULT_PORT = 3050;

function validPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`ours: ${value} is not a valid TCP port`);
  return port;
}

export function parseOursArgs(argv = []) {
  const codexArgs = [];
  let port;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--ours-port') {
      if (argv[i + 1] == null) throw new Error('ours: --ours-port requires a value');
      port = validPort(argv[++i]);
    } else if (arg.startsWith('--ours-port=')) {
      port = validPort(arg.slice('--ours-port='.length));
    } else {
      codexArgs.push(arg);
    }
  }
  return { port, codexArgs };
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return {}; }
}

async function readOwnerToken(stateDir) {
  try { return (await readFile(join(stateDir, 'daemon-token'), 'utf8')).trim() || null; } catch { return null; }
}

export async function resolveDaemonProfile({ argv = [], env = process.env, readConfig, fetch: fetchImpl = globalThis.fetch } = {}) {
  const parsed = parseOursArgs(argv);
  const configPath = env.OURS_CONFIG || join(env.HOME || homedir(), '.ours', 'config.json');
  const config = await (readConfig ? readConfig(configPath) : readJson(configPath));
  let source = 'default';
  let port = DEFAULT_PORT;
  if (config?.port != null) { port = validPort(config.port); source = env.OURS_CONFIG ? 'OURS_CONFIG' : 'config'; }
  if (env.OURS_PORT != null && env.OURS_PORT !== '') { port = validPort(env.OURS_PORT); source = 'OURS_PORT'; }
  if (parsed.port != null) { port = parsed.port; source = '--ours-port'; }

  const baseUrl = `http://127.0.0.1:${port}`;
  let response;
  try { response = await fetchImpl(`${baseUrl}/info`, { signal: AbortSignal.timeout(2000) }); }
  catch (error) {
    throw new Error(`ours daemon on port ${port} is not reachable; ours-codex never starts it. Start the selected daemon first. (${error?.message || error})`);
  }
  if (!response.ok) throw new Error(`ours daemon on port ${port} returned HTTP ${response.status}`);
  const info = await response.json();
  if (info?.name !== 'ours' || !Number.isInteger(info?.protocol) || info.protocol < 1 || typeof info?.stateDir !== 'string') {
    throw new Error(`incompatible service on port ${port}; expected an ours daemon with notification protocol 1`);
  }
  const stateDir = resolve(info.stateDir);
  const token = env.OURS_API_TOKEN?.trim() || config?.apiToken?.trim() || await readOwnerToken(stateDir);
  const headers = token ? { 'x-ours-api-token': token } : {};
  let capability;
  try { capability = await fetchImpl(`${baseUrl}/identities`, { headers, signal: AbortSignal.timeout(2000) }); }
  catch (error) { throw new Error(`ours daemon capability check failed: ${error?.message || error}`); }
  if (capability.status === 401 || capability.status === 403) throw new Error(`ours daemon authentication failed on port ${port}; supply the matching OURS_API_TOKEN/config`);
  if (!capability.ok) throw new Error(`selected daemon lacks the notification API (HTTP ${capability.status})`);
  let unread;
  try { unread = await fetchImpl(`${baseUrl}/unread`, { headers, signal: AbortSignal.timeout(2000) }); }
  catch (error) { throw new Error(`ours daemon unread capability check failed: ${error?.message || error}`); }
  if (unread.status === 401 || unread.status === 403) throw new Error(`ours daemon authentication failed on port ${port}; supply the matching OURS_API_TOKEN/config`);
  if (!unread.ok) throw new Error(`selected daemon lacks the body-free unread API (HTTP ${unread.status}); install the testing daemon build and restart that daemon explicitly`);

  return {
    port, stateDir, token: token || null,
    visibility: env.OURS_API_VISIBILITY || config?.apiVisibility || 'owner',
    source, info, baseUrl, configPath, codexArgs: parsed.codexArgs,
  };
}
