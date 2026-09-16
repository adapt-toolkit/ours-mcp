import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { assertDaemonStateDir, attachOursClient, resolveDaemonConfig } from '@ours.network/sdk';
import { hostProfileSelectionFromEnv } from '../../core/src/host-client/index.ts';

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

export async function resolveDaemonProfile({ argv = [], env = process.env, fetch: fetchImpl = globalThis.fetch, attach = attachOursClient } = {}) {
  const parsed = parseOursArgs(argv);
  const hostSelection = hostProfileSelectionFromEnv(env);
  if (hostSelection !== null) {
    const { profile: hostProfile, configPath } = hostSelection;
    if (parsed.port != null) throw new Error('ours: --ours-port conflicts with host-profile mode');
    const client = await attach({ ...hostProfile, sessionMode: 'external', leaseToken: randomUUID(), env: {} });
    let info;
    try {
      info = await client.version();
      await client.identities();
      await client.unread();
    } finally { await client.close(); }
    return { profile: hostProfile, info, baseUrl: hostProfile.endpoint, configPath, codexArgs: parsed.codexArgs };
  }
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
