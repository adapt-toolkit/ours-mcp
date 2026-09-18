import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { attachOursClient } from '@ours.network/sdk';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const cliRoot = dirname(require.resolve('@ours.network/cli/package.json'));
const cli = join(cliRoot, 'dist', 'cli.js');
const root = mkdtempSync(join(tmpdir(), 'ours-network-integration-'));
const stateDir = join(root, 'state');
const configPath = join(root, 'daemon.json');
const applicationConfigPath = join(root, 'application-identities.json');
const credentialPath = join(stateDir, 'daemon-token');
const instanceId = randomUUID();
const port = await new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    server.close(() => resolve(address.port));
  });
});
const endpoint = `http://127.0.0.1:${port}`;
writeFileSync(configPath, `${JSON.stringify({
  brokerUrl: 'wss://invalid.local/none',
  port,
  stateDir,
  apiVisibility: 'owner',
  networkMcp: {
    profile: { endpoint, expectedInstanceId: instanceId, credentialPath },
    applicationConfigPath,
  },
}, null, 2)}\n`, { mode: 0o600 });
chmodSync(configPath, 0o600);

const daemon = spawn(process.execPath, [cli, 'daemon', 'serve', '--config', configPath], {
  env: { ...process.env, OURS_DAEMON_ID: instanceId },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const exited = once(daemon, 'exit');
let output = '';
for (const stream of [daemon.stdout, daemon.stderr]) {
  stream.on('data', (chunk) => { output = (output + chunk).slice(-30_000); });
}

const owners = [randomUUID(), randomUUID()];
const clients = [];
const apiClients = [];

async function connect(owner, name) {
  const token = readFileSync(credentialPath, 'utf8').trim();
  const transport = new StreamableHTTPClientTransport(new URL(`${endpoint}/mcp`), {
    requestInit: {
      headers: {
        'x-ours-api-token': token,
        'x-ours-lease-token': owner,
        'x-ours-session-mode': 'external',
      },
    },
  });
  const client = new Client({ name, version: '1' }, { capabilities: {} });
  const notifications = [];
  client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
    notifications.push(notification.params);
  });
  await client.connect(transport);
  clients.push(client);
  return { client, notifications };
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, false, `${name} failed: ${JSON.stringify(result)}`);
  return result;
}

try {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    assert.equal(daemon.exitCode, null, output);
    try {
      if ((await fetch(`${endpoint}/selection`)).ok && readFileSync(credentialPath, 'utf8').trim()) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(daemon.exitCode, null, output);

  const alice = await connect(owners[0], 'network-alice');
  const bob = await connect(owners[1], 'network-bob');
  const tools = await alice.client.listTools();
  assert.ok(tools.tools.some((tool) => tool.name === 'send_message'),
    'the packaged listener serves the real core tool vocabulary');

  await call(alice.client, 'create_identity', { name: 'NetworkAlice', expose_local: true, local_auto_accept: true });
  await call(bob.client, 'create_identity', { name: 'NetworkBob', expose_local: true, local_auto_accept: true });

  const resource = await bob.client.readResource({ uri: 'ours://application-identities' });
  assert.deepEqual(JSON.parse(resource.contents[0].text), { identities: ['NetworkAlice', 'NetworkBob'] });

  await new Promise((resolve) => setTimeout(resolve, 500));
  await call(alice.client, 'send_message', { contact: 'NetworkBob', text: 'notification body must stay hidden' });
  const notifyDeadline = Date.now() + 15_000;
  while (Date.now() < notifyDeadline && bob.notifications.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(bob.notifications.some((entry) => String(entry.data).includes('new message from NetworkAlice')),
    `arrival notification was not delivered: ${JSON.stringify(bob.notifications)}\n${output}`);
  assert.equal(bob.notifications.some((entry) => JSON.stringify(entry).includes('notification body must stay hidden')), false,
    'arrival notifications do not expose message bodies');

  const save = await call(bob.client, 'save_file', {
    wire_id: 'A'.repeat(64), dest_path: '/host/chosen/network.bin',
  });
  assert.deepEqual(save.structuredContent, {
    oursHostSave: { wire_id: 'A'.repeat(64), dest_path: '/host/chosen/network.bin' },
  });

  const token = readFileSync(credentialPath, 'utf8').trim();
  for (const [index, owner] of owners.entries()) {
    apiClients[index] = await attachOursClient({
      endpoint, expectedInstanceId: instanceId, token, sessionMode: 'external', leaseToken: owner, env: {},
    });
  }
  await bob.client.close();
  clients.splice(clients.indexOf(bob.client), 1);
  assert.equal((await apiClients[1].currentIdentity()).name, 'NetworkBob',
    'MCP DELETE closes only the external transport and preserves its native owner');
  await assert.rejects(
    () => apiClients[0].chooseIdentity({ name: 'NetworkBob', force: false }),
    (error) => error?.code === 'BOUND_ELSEWHERE',
    'a sibling external owner cannot take the preserved binding',
  );
} finally {
  for (const client of apiClients) {
    try { await client?.releaseLease(); } catch {}
  }
  for (const client of clients) {
    try { await client.close(); } catch {}
  }
  daemon.kill('SIGTERM');
  const timer = setTimeout(() => daemon.kill('SIGKILL'), 7_000);
  await exited;
  clearTimeout(timer);
  rmSync(root, { recursive: true, force: true });
}

console.log('network-integration: packaged tools, resource, notification, file intent, and owner lifetime verified');
