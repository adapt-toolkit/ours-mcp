import assert from 'node:assert/strict';
import { attachOursClient } from '@ours.network/sdk';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Runtime lifecycle and token administration belong to ours-daemon, not the client CLI.
const require = createRequire(import.meta.url);
const cli = process.env.OURS_TEST_DAEMON_CLI
  ?? join(dirname(require.resolve('@ours.network/daemon/package.json')), 'dist', 'cli.js');
const root = mkdtempSync(join(tmpdir(), 'ours-mcp-refresh-'));
const daemonState = join(root, 'daemon'); const hostState = join(root, 'host'); const deliveryState = join(root, 'delivery');
for (const directory of [daemonState, hostState, deliveryState]) mkdirSync(directory, { mode: 0o700 });
const port = await new Promise((resolve, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); }); });
const endpoint = `http://127.0.0.1:${port}`;
const expectedInstanceId = randomUUID();
const daemonConfig = join(daemonState, 'daemon-config.json');
const credentialPath = join(hostState, 'daemon-token'); const deliveryPath = join(deliveryState, 'daemon-token'); const profilePath = join(hostState, 'profile.json');
writeFileSync(daemonConfig, JSON.stringify({ stateDir: daemonState, port, apiVisibility: 'owner', apiTokenDeliveryFiles: [deliveryPath] }), { mode: 0o600 });
const daemonEnv = { ...process.env, OURS_CONFIG: daemonConfig, OURS_STATE_DIR: daemonState, OURS_PORT: String(port), OURS_DAEMON_ID: expectedInstanceId, OURS_API_VISIBILITY: 'owner', OURS_BROKER_URL: 'wss://invalid.local/none' };
for (const key of ['OURS_API_TOKEN', 'OURS_TLS_CERT', 'OURS_TLS_KEY', 'OURS_LISTEN_HOST']) delete daemonEnv[key];
const daemon = spawn('node', [cli, 'serve', '--managed'], { env: daemonEnv, stdio: ['ignore', 'pipe', 'pipe'] });
let daemonOutput = ''; let proxy; let gateway; for (const stream of [daemon.stdout, daemon.stderr]) stream.on('data', (value) => { daemonOutput = (daemonOutput + value).slice(-12000); });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) { assert.equal(daemon.exitCode, null, daemonOutput); try { const response = await fetch(`${endpoint}/selection`, { signal: AbortSignal.timeout(500) }); if (response.ok && (await response.json()).instanceId === expectedInstanceId) break; } catch {} await pause(100); }
  assert.equal(daemon.exitCode, null, daemonOutput);
  assert.equal((await fetch(`${endpoint}/selection`)).status, 200, daemonOutput);
  copyFileSync(join(daemonState, 'daemon-token'), credentialPath); copyFileSync(join(daemonState, 'daemon-token'), deliveryPath);
  const gatewayPort = await new Promise((resolve, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); }); });
  gateway = spawn(process.execPath, [fileURLToPath(new URL('../test-support/prefixed-daemon.mjs', import.meta.url)), String(gatewayPort), endpoint], { stdio: ['ignore', 'pipe', 'inherit'] });
  await once(gateway.stdout, 'data', { signal: AbortSignal.timeout(10000) });
  const serverUrl = `http://127.0.0.1:${gatewayPort}/base`;
  const gatewayEndpoint = `${serverUrl}/daemon`;
  writeFileSync(profilePath, JSON.stringify({ serverUrl, endpoint: gatewayEndpoint, expectedInstanceId, credentialPath }), { mode: 0o600 });
  const support = fileURLToPath(new URL('../test-support/external-profile-proxy.mjs', import.meta.url));
  const proxyEnv = { ...process.env, OURS_CONFIG: profilePath, OURS_MCP_CONFIG: join(hostState, 'mcp-identities.json') }; for (const key of Object.keys(proxyEnv)) if (key.startsWith('OURS_') && key !== 'OURS_CONFIG' && key !== 'OURS_MCP_CONFIG') delete proxyEnv[key];
  proxy = spawn('node', [support, profilePath, 'fixture-owner-opaque'], { env: proxyEnv, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = ''; const pending = new Map(); let stderr = '';
  proxy.stderr.on('data', (value) => { stderr = (stderr + value).slice(-12000); });
  const rejectPending = (error) => { for (const request of pending.values()) request.reject(error); pending.clear(); };
  proxy.once('error', rejectPending);
  proxy.once('exit', (code, signal) => rejectPending(new Error(`MCP proxy exited (${code ?? signal}): ${stderr}`)));
  proxy.stdin.on('error', rejectPending);
  proxy.stdout.on('data', (value) => {
    buffer += value;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      let frame;
      try { frame = JSON.parse(line); } catch { continue; }
      pending.get(frame.id)?.resolve(frame);
    }
  });
  let nextId = 1;
  const request = (method, params) => new Promise((resolve, reject) => {
    if (proxy.exitCode !== null || proxy.signalCode !== null) { reject(new Error(`MCP proxy already exited: ${stderr}`)); return; }
    const id = nextId++;
    const settle = (callback, value) => { clearTimeout(timer); pending.delete(id); callback(value); };
    const timer = setTimeout(() => settle(reject, new Error(`MCP ${method} timed out: ${stderr}`)), 30000);
    pending.set(id, { resolve: (value) => settle(resolve, value), reject: (error) => settle(reject, error) });
    proxy.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const initialize = await request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'refresh', version: '1' } }); assert.ok(initialize.result, stderr); proxy.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const tools = await request('tools/list', {}); assert.ok(Array.isArray(tools.result?.tools) && tools.result.tools.some((tool) => tool.name === 'list_identities'));
  const before = await request('tools/call', { name: 'create_root_identity', arguments: { name: 'RefreshFixture', bio: '', expose_local: false, local_auto_accept: true } }); assert.equal(before.result?.isError, false, JSON.stringify(before));
  const currentBefore = await request('tools/call', { name: 'current_identity', arguments: {} }); assert.match(JSON.stringify(currentBefore), /RefreshFixture/);
  const oldToken = readFileSync(credentialPath, 'utf8').trim();
  const updateEnv = { ...process.env, OURS_CONFIG: profilePath }; for (const key of Object.keys(updateEnv)) if (key.startsWith('OURS_') && key !== 'OURS_CONFIG') delete updateEnv[key];
  const update = spawn('node', [cli, 'config', 'token-update', '--config', profilePath, '--json'], { env: updateEnv, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 }); let updateOut = ''; let updateErr = ''; update.stdout.on('data', (value) => { updateOut += value; }); update.stderr.on('data', (value) => { updateErr += value; }); const [code] = await once(update, 'exit'); assert.equal(code, 0, updateErr || updateOut);
  assert.equal((await fetch(`${gatewayEndpoint}/version`, { headers: { authorization: `Bearer ${oldToken}` }, signal: AbortSignal.timeout(5000) })).status, 401, 'old token is rejected after official update');
  const listedAfter = await request('tools/call', { name: 'list_identities', arguments: {} }); assert.equal(listedAfter.result?.isError, false, JSON.stringify(listedAfter));
  const currentAfter = await request('tools/call', { name: 'current_identity', arguments: {} }); assert.equal(currentAfter.result?.isError, false, JSON.stringify(currentAfter)); assert.match(JSON.stringify(currentAfter), /RefreshFixture/, 'same MCP process retains its bound identity after credential replacement');
  proxy.stdin.end(); const [proxyCode] = await once(proxy, 'exit', { signal: AbortSignal.timeout(10000) }); assert.equal(proxyCode, 0, stderr);
  const retained = await attachOursClient({ endpoint: gatewayEndpoint, expectedInstanceId, credentialPath, sessionMode: 'external', leaseToken: 'fixture-owner-opaque', env: {} });
  try { assert.equal((await retained.currentIdentity()).name, 'RefreshFixture', 'stdin EOF does not release the external owner binding'); } finally { await retained.close(); }
  console.log('external-profile-stdio-refresh: official token update refreshed one living MCP process');
} finally { if (gateway?.exitCode === null) gateway.kill('SIGTERM'); if (proxy && proxy.exitCode === null) { try { proxy.stdin.end(); } catch {} await Promise.race([once(proxy, 'exit'), pause(1000)]); if (proxy.exitCode === null) proxy.kill('SIGKILL'); } if (daemon.exitCode === null) daemon.kill('SIGTERM'); await Promise.race([once(daemon, 'exit'), pause(7000)]); if (daemon.exitCode === null) daemon.kill('SIGKILL'); }
