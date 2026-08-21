import { join } from 'node:path';
import { homedir } from 'node:os';

import { assertDaemonStateDir, resolveDaemonConfig } from '@ours.network/sdk';

function validPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`ours: ${value} is not a valid TCP port`);
  return port;
}

export function parseOursArgs(argv = []) {
  const codexArgs = [];
  let port;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--ours-port') {
      if (argv[index + 1] == null) throw new Error('ours: --ours-port requires a value');
      port = validPort(argv[++index]);
    } else if (arg.startsWith('--ours-port=')) {
      port = validPort(arg.slice('--ours-port='.length));
    } else {
      codexArgs.push(arg);
    }
  }
  return { port, codexArgs };
}

export async function resolveDaemonProfile({ argv = [], env = process.env, fetch: fetchImpl = globalThis.fetch } = {}) {
  const parsed = parseOursArgs(argv);
  const selection = resolveDaemonConfig({
    ...(parsed.port == null ? {} : { port: parsed.port }),
    env,
    homeDir: env.HOME || homedir(),
  });
  await assertDaemonStateDir(selection, { fetch: fetchImpl, timeoutMs: 2000 });

  const baseUrl = selection.baseUrl.value;
  const token = selection.token?.value ?? null;
  const headers = token ? { 'x-ours-api-token': token } : {};
  const response = await fetchImpl(`${baseUrl}/info`, { signal: AbortSignal.timeout(2000) });
  if (!response.ok) throw new Error(`ours daemon at ${baseUrl} returned HTTP ${response.status}`);
  const info = await response.json();
  if (info?.name !== 'ours' || !Number.isInteger(info?.protocol) || info.protocol < 1) {
    throw new Error(`incompatible service at ${baseUrl}; expected an ours daemon with notification protocol 1`);
  }
  for (const path of ['/identities', '/unread']) {
    const capability = await fetchImpl(`${baseUrl}${path}`, { headers, signal: AbortSignal.timeout(2000) });
    if (capability.status === 401 || capability.status === 403) {
      throw new Error(`ours daemon authentication failed at ${baseUrl}; supply the matching coherent selection`);
    }
    if (!capability.ok) throw new Error(`selected daemon lacks ${path} (HTTP ${capability.status})`);
  }

  return {
    port: selection.port.value,
    stateDir: selection.expectStateDir,
    token,
    visibility: 'owner',
    source: selection.baseUrl.source,
    info,
    baseUrl,
    configPath: selection.configPath?.value ?? join(selection.expectStateDir, 'config.json'),
    codexArgs: parsed.codexArgs,
  };
}
