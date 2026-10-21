import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { hostProfileFromEnv, nativeClientForAtRoot } from '../../core/src/host-client/index.ts';

export async function runNetworkWatch({
  identity,
  nativeSessionId,
  env = process.env,
  profile: profileValue,
  hostRecordRoot: hostRecordRootValue,
  clientFor = nativeClientForAtRoot,
  write = (value) => process.stdout.write(value),
  installSignalHandlers = true,
} = {}) {
  if (typeof identity !== 'string' || !identity.trim()) throw new Error('identity is required');
  if (typeof nativeSessionId !== 'string' || !nativeSessionId.trim()) throw new Error('native session id is required');
  const profile = profileValue ?? hostProfileFromEnv(env);
  if (!profile) throw new Error('A selected host network profile is required.');
  const appPath = env.OURS_MCP_CONFIG || join(env.HOME || homedir(), '.ours-mcp', 'config.json');
  const hostRecordRoot = hostRecordRootValue ?? dirname(appPath);
  const controller = new AbortController();
  const stop = () => controller.abort();
  if (installSignalHandlers) {
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }
  let client;
  try {
    client = await clientFor(profile, nativeSessionId, hostRecordRoot);
    for await (const event of client.watchNotifications(identity, { kinds: ['inbound'], signal: controller.signal })) {
      const summary = event?.event === 'file_received'
        ? `[${identity}] new file ${event.filename ?? '?'} from ${event.from ?? '?'}`
        : `[${identity}] new message from ${event?.from ?? '?'}`;
      write(`${summary}\n`);
      return;
    }
  } finally {
    if (installSignalHandlers) {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    }
    await client?.close();
  }
}
