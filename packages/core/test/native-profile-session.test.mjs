import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const daemonCli = process.env.OURS_TEST_DAEMON_CLI;
assert.ok(daemonCli, 'OURS_TEST_DAEMON_CLI must name the official cached runtime CLI');
const cli = process.env.OURS_TEST_MCP_CLI ?? fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const value = server.address().port;
      server.close(() => resolve(value));
    });
  });
}

async function connectProxy(env, name) {
  const child = spawn('node', [cli, 'proxy'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  let stderr = '';
  let nextId = 1;
  const pending = new Map();
  child.stderr.on('data', (value) => { stderr += value; });
  child.stdout.on('data', (value) => {
    buffer += value;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      try {
        const frame = JSON.parse(line);
        if (frame.id !== undefined && pending.has(frame.id)) {
          pending.get(frame.id)(frame);
          pending.delete(frame.id);
        }
      } catch { /* log line */ }
    }
  });
  const request = (method, params) => new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const initialized = await request('initialize', {
    protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name, version: '1' },
  });
  assert.ok(initialized.result, stderr);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  return {
    child,
    listTools: () => request('tools/list', {}),
    call: (toolName, args = {}, sessionId) => request('tools/call', {
      name: toolName,
      arguments: args,
      ...(sessionId === undefined ? {} : { _meta: { threadId: sessionId } }),
    }),
  };
}

async function stopProxy(proxy) {
  if (!proxy || proxy.child.exitCode !== null) return;
  try { proxy.child.stdin.end(); } catch { /* already closed */ }
  await Promise.race([once(proxy.child, 'exit'), pause(1000)]).catch(() => {});
  if (proxy.child.exitCode === null) proxy.child.kill('SIGKILL');
}

async function sessionEnd(env, sessionId) {
  const child = spawn('node', [cli, 'session-end'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (value) => { stderr += value; });
  child.stdin.end(`${JSON.stringify({ session_id: sessionId })}\n`);
  const [code, signal] = await once(child, 'exit');
  assert.equal(code, 0, stderr || `signal=${signal}`);
}

function records(hostState, expectedInstanceId) {
  const directory = join(hostState, 'sessions', expectedInstanceId);
  if (!existsSync(directory)) return [];
  return readdirSync(directory).sort().map((name) => {
    const path = join(directory, name);
    return { path, value: JSON.parse(readFileSync(path, 'utf8')) };
  });
}

function ownerFor(hostState, expectedInstanceId, ownerInstanceId) {
  return records(hostState, expectedInstanceId).find((row) => row.value.ownerInstanceId === ownerInstanceId);
}

const root = mkdtempSync(join(tmpdir(), 'ours-native-profile-'));
const daemonState = join(root, 'daemon');
const hostState = join(root, 'host');
const deliveryState = join(root, 'delivery');
for (const directory of [daemonState, hostState, deliveryState]) mkdirSync(directory, { mode: 0o700 });
const port = await freePort();
const endpoint = `http://127.0.0.1:${port}`;
const expectedInstanceId = randomUUID();
const daemonConfig = join(daemonState, 'daemon-config.json');
const credentialPath = join(hostState, 'daemon-token');
const deliveryPath = join(deliveryState, 'daemon-token');
const profilePath = join(hostState, 'profile.json');
writeFileSync(daemonConfig, JSON.stringify({
  stateDir: daemonState, port, apiVisibility: 'owner', apiTokenDeliveryFiles: [deliveryPath],
}), { mode: 0o600 });
const daemonEnv = {
  ...process.env,
  OURS_CONFIG: daemonConfig,
  OURS_STATE_DIR: daemonState,
  OURS_PORT: String(port),
  OURS_DAEMON_ID: expectedInstanceId,
  OURS_API_VISIBILITY: 'owner',
  OURS_BROKER_URL: 'wss://invalid.local/none',
};
for (const key of ['OURS_API_TOKEN', 'OURS_TLS_CERT', 'OURS_TLS_KEY', 'OURS_LISTEN_HOST']) delete daemonEnv[key];
const daemon = spawn('node', [daemonCli, 'daemon', 'serve', '--managed'], {
  env: daemonEnv, stdio: ['ignore', 'pipe', 'pipe'],
});
let daemonOutput = '';
for (const stream of [daemon.stdout, daemon.stderr]) {
  stream.on('data', (value) => { daemonOutput = (daemonOutput + value).slice(-12000); });
}

let proxy;
try {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    assert.equal(daemon.exitCode, null, daemonOutput);
    try {
      const response = await fetch(`${endpoint}/selection`, { signal: AbortSignal.timeout(500) });
      if (response.ok && (await response.json()).instanceId === expectedInstanceId) break;
    } catch { /* booting */ }
    await pause(100);
  }
  assert.equal((await fetch(`${endpoint}/selection`)).status, 200, daemonOutput);
  assert.equal((await fetch(`${endpoint}/mcp`, { method: 'POST' })).status, 404, 'production daemon has no remote MCP route');
  copyFileSync(join(daemonState, 'daemon-token'), credentialPath);
  copyFileSync(join(daemonState, 'daemon-token'), deliveryPath);
  writeFileSync(profilePath, JSON.stringify({ endpoint, expectedInstanceId, credentialPath }), { mode: 0o600 });
  const proxyEnv = {
    ...process.env,
    OURS_CONFIG: profilePath,
    OURS_MCP_CONFIG: join(hostState, 'mcp-identities.json'),
  };
  for (const key of Object.keys(proxyEnv)) {
    if (key.startsWith('OURS_') && !['OURS_CONFIG', 'OURS_MCP_CONFIG', 'OURS_TEST_DAEMON_CLI'].includes(key)) delete proxyEnv[key];
  }
  delete proxyEnv.CLAUDE_CODE_SESSION_ID;

  const sessionA = randomUUID();
  const sessionB = randomUUID();
  proxy = await connectProxy(proxyEnv, 'native-profile-first');
  const tools = await proxy.listTools();
  assert.ok(tools.result?.tools?.some((tool) => tool.name === 'list_identities'));
  assert.equal(records(hostState, expectedInstanceId).length, 0, 'initialize and discovery allocate no owner');
  const missing = await proxy.call('list_identities');
  assert.equal(missing.result?.isError, true, JSON.stringify(missing));
  assert.match(JSON.stringify(missing), /Native session metadata is missing or invalid/);

  const permanentA = await proxy.call('create_identity', {
    name: 'NativePermanent', bio: '', expose_local: false, local_auto_accept: true,
  }, sessionA);
  assert.equal(permanentA.result?.isError, false, JSON.stringify(permanentA));
  const activeA = records(hostState, expectedInstanceId).find((row) => row.value.state === 'active');
  assert.ok(activeA);
  assert.equal(statSync(activeA.path).mode & 0o077, 0, 'native record is private');
  const ownerA = activeA.value.ownerInstanceId;

  const unboundB = await proxy.call('current_identity', {}, sessionB);
  assert.equal(unboundB.result?.isError, false, JSON.stringify(unboundB));
  assert.match(JSON.stringify(unboundB), /No identity bound/);
  const permanentB = await proxy.call('create_identity', {
    name: 'NativeSibling', bio: '', expose_local: false, local_auto_accept: true,
  }, sessionB);
  assert.equal(permanentB.result?.isError, false, JSON.stringify(permanentB));
  const currentA = await proxy.call('current_identity', {}, sessionA);
  assert.match(JSON.stringify(currentA), /NativePermanent/, 'selector A binding survives selector B calls');

  const temporaryA = await proxy.call('create_temporary_identity', {
    name: 'NativeTemporary', bio: '', expose_local: false, local_auto_accept: true,
  }, sessionA);
  assert.equal(temporaryA.result?.isError, false, JSON.stringify(temporaryA));
  assert.ok(existsSync(join(daemonState, 'NativeTemporary')));
  const ownerB = records(hostState, expectedInstanceId)
    .find((row) => row.value.state === 'active' && row.value.ownerInstanceId !== ownerA)?.value.ownerInstanceId;
  assert.ok(ownerB && ownerB !== ownerA, 'different selectors use different owner UUIDs');

  await stopProxy(proxy);
  proxy = await connectProxy(proxyEnv, 'native-profile-recycled');
  const recoveredA = await proxy.call('current_identity', {}, sessionA);
  const recoveredB = await proxy.call('current_identity', {}, sessionB);
  assert.match(JSON.stringify(recoveredA), /NativeTemporary/, 'MCP recycle recovers selector A owner and binding');
  assert.match(JSON.stringify(recoveredB), /NativeSibling/, 'MCP recycle recovers selector B independently');
  assert.ok(ownerFor(hostState, expectedInstanceId, ownerA));
  assert.ok(ownerFor(hostState, expectedInstanceId, ownerB));

  await sessionEnd(proxyEnv, sessionA);
  assert.ok(!existsSync(join(daemonState, 'NativeTemporary')), 'exact SessionEnd removes owned temporary state');
  assert.ok(existsSync(join(daemonState, 'NativePermanent')), 'SessionEnd preserves permanent state');
  assert.ok(existsSync(join(daemonState, 'NativeSibling')), 'SessionEnd preserves sibling state');
  assert.equal(ownerFor(hostState, expectedInstanceId, ownerA).value.state, 'ended');
  await sessionEnd(proxyEnv, sessionA);
  assert.equal(ownerFor(hostState, expectedInstanceId, ownerA).value.state, 'ended', 'duplicate SessionEnd is idempotent');

  const resumedA = await proxy.call('current_identity', {}, sessionA);
  assert.equal(resumedA.result?.isError, false, JSON.stringify(resumedA));
  assert.match(JSON.stringify(resumedA), /No identity bound/);
  const freshA = JSON.parse(readFileSync(activeA.path, 'utf8'));
  assert.equal(freshA.state, 'active');
  assert.notEqual(freshA.ownerInstanceId, ownerA, 'same-process resume allocates a fresh owner after acknowledged end');
  const stillB = await proxy.call('current_identity', {}, sessionB);
  assert.match(JSON.stringify(stillB), /NativeSibling/, 'ending and resuming selector A does not disturb selector B');

  const pendingSession = randomUUID();
  const chosePending = await proxy.call('choose_identity', { name: 'NativePermanent', force: false }, pendingSession);
  assert.equal(chosePending.result?.isError, false, JSON.stringify(chosePending));
  const pendingTemp = await proxy.call('create_temporary_identity', {
    name: 'PendingTemporary', bio: '', expose_local: false, local_auto_accept: true,
  }, pendingSession);
  assert.equal(pendingTemp.result?.isError, false, JSON.stringify(pendingTemp));
  const pendingRecord = records(hostState, expectedInstanceId)
    .find((row) => row.value.state === 'active' && ![freshA.ownerInstanceId, ownerB].includes(row.value.ownerInstanceId));
  assert.ok(pendingRecord);
  const pendingOwner = pendingRecord.value.ownerInstanceId;
  writeFileSync(pendingRecord.path, `${JSON.stringify({ ...pendingRecord.value, state: 'pending' }, null, 2)}\n`, { mode: 0o600 });
  const recoveredPending = await proxy.call('current_identity', {}, pendingSession);
  assert.match(JSON.stringify(recoveredPending), /No identity bound/);
  assert.ok(!existsSync(join(daemonState, 'PendingTemporary')), 'pending terminal intent is recovered before successor allocation');
  const pendingFresh = JSON.parse(readFileSync(pendingRecord.path, 'utf8'));
  assert.equal(pendingFresh.state, 'active');
  assert.notEqual(pendingFresh.ownerInstanceId, pendingOwner, 'pending recovery keeps the captured owner immutable');

  const claudeSession = randomUUID();
  const claudeEnv = { ...proxyEnv, CLAUDE_CODE_SESSION_ID: claudeSession };
  const claude = await connectProxy(claudeEnv, 'native-profile-claude-fallback');
  try {
    const fallback = await claude.call('list_identities');
    assert.equal(fallback.result?.isError, false, JSON.stringify(fallback));
  } finally {
    await stopProxy(claude);
  }
  await sessionEnd(claudeEnv, claudeSession);

  const containerState = join(root, 'container');
  mkdirSync(join(containerState, '.mcp'), { recursive: true, mode: 0o700 });
  copyFileSync(profilePath, join(containerState, '.mcp/profile.json'));
  copyFileSync(proxyEnv.OURS_MCP_CONFIG, join(containerState, '.mcp/config.json'));
  const containerEntry = fileURLToPath(new URL('../dist/container.js', import.meta.url));
  for (const command of ['version', 'application-identities', 'hook-state', 'watch']) {
    const result = spawnSync(process.execPath, [containerEntry, expectedInstanceId, command], {
      env: { ...proxyEnv, OURS_STATE_DIR: containerState, OURS_DAEMON_ID: expectedInstanceId },
      input: '', encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.status, 0, `${command}: ${result.stderr}`);
    if (command === 'application-identities') assert(JSON.parse(result.stdout).includes('NativePermanent'));
    if (command === 'hook-state') assert(JSON.parse(result.stdout).identities.includes('NativePermanent'));
  }
  console.log('container entrypoint: CLI delegation, application visibility, hook state and watch EOF passed');
  console.log('native-profile-session: lazy allocation, sibling isolation, recycle, exact end, pending recovery, and resume passed');
} finally {
  await stopProxy(proxy);
  if (daemon.exitCode === null) daemon.kill('SIGTERM');
  await Promise.race([once(daemon, 'exit'), pause(7000)]).catch(() => {});
  if (daemon.exitCode === null) daemon.kill('SIGKILL');
  rmSync(root, { recursive: true, force: true });
}
