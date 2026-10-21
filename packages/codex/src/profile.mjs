import { randomUUID } from 'node:crypto';

import { attachOursClient } from '@ours.network/sdk';
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
