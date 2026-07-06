// packages/core/test/lease-binding.test.mjs
// Drives the BUILT daemon over loopback HTTP as TWO synthetic connectors
// (distinct tokens/pids) to exercise the lease table directly.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'dist', 'cli.js');
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓', m)) : (fail++, console.log('  ✗ FAIL:', m)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });

// A connector = an MCP client with fixed token+pid headers.
async function connector(url, token, pid) {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { 'x-ours-lease-token': token, 'x-ours-client-pid': String(pid) } },
  });
  const client = new Client({ name: `c-${token}`, version: '0.0.0' });
  await client.connect(transport);
  return {
    client,
    call: (name, args = {}) => client.callTool({ name, arguments: args }),
    close: async () => { await transport.terminateSession(); await client.close(); },
  };
}
const isErr = (r) => r.isError === true || (Array.isArray(r.content) && /failed|declined|reassigned|No identity/i.test(r.content.map((c) => c.text || '').join(' ')));

const dir = mkdtempSync(join(tmpdir(), 'a2a-lease-'));
const PORT = await freePort();
const URL_ = `http://127.0.0.1:${PORT}/mcp`;
// This suite drives /mcp directly as synthetic connectors (no proxy, no API
// token), so run the daemon in `open` visibility — auth is covered separately by
// port-visibility.test.mjs.
const daemon = spawn('node', [CLI, 'serve'], { env: { ...process.env, OURS_TRANSPORT: 'http', OURS_PORT: String(PORT), OURS_STATE_DIR: dir, OURS_BROKER_URL: 'wss://invalid.local/none', OURS_API_VISIBILITY: 'open' }, stdio: 'ignore' });
try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/version`)).ok) break; } catch {} await sleep(250); }

  // A pid we know is DEAD: spawn `true`, capture pid, wait for exit.
  const corpse = spawn('node', ['-e', 'process.exit(0)']);
  const deadPid = corpse.pid;
  await new Promise((r) => corpse.on('exit', r));

  const A = await connector(URL_, 'tokA', process.pid);          // alive holder
  await A.call('create_identity', { name: 'Alice', expose_local: false });
  ok(!isErr(await A.call('list_contacts')), 'A holds Alice and can call per-container tools');

  // B (different token) cannot take a LIVE holder without force.
  const B = await connector(URL_, 'tokB', process.pid);
  ok(isErr(await B.call('choose_identity', { name: 'Alice' })), 'B is declined: Alice held by a live pid');

  // B CAN force-take; A is then fenced (tombstoned).
  ok(!isErr(await B.call('choose_identity', { name: 'Alice', force: true })), 'B force-takes Alice');
  ok(isErr(await A.call('list_contacts')), 'A is fenced after force takeover (reassigned)');

  // Dead-pid auto-reclaim: connector D claims a holder whose pid is dead.
  const C = await connector(URL_, 'tokC', deadPid);              // "holds" then dies
  await C.call('create_identity', { name: 'Bob', expose_local: false });
  const D = await connector(URL_, 'tokD', process.pid);
  ok(!isErr(await D.call('choose_identity', { name: 'Bob' })), 'D auto-reclaims Bob from a dead pid (no force)');

  // Clean release frees immediately: B releases (close → DELETE), E binds plainly.
  await B.close();
  await sleep(300);
  const E = await connector(URL_, 'tokE', process.pid);
  ok(!isErr(await E.call('choose_identity', { name: 'Alice' })), 'E binds Alice after B released it');

  // Idle-protection: a holder whose CLIENT pid is alive is NOT reclaimable without force,
  // even after its connector has been torn down (simulating an idle Claude session).
  const liveClient = spawn('node', ['-e', 'setInterval(()=>{},1e9)']); // stays alive
  const idleHolder = await connector(URL_, 'tokIdle', liveClient.pid);
  await idleHolder.call('create_identity', { name: 'Carol', expose_local: false });
  // idleHolder's "connector" is gone, but its CLIENT pid is alive:
  const other = await connector(URL_, 'tokOther', process.pid);
  ok(isErr(await other.call('choose_identity', { name: 'Carol' })),
     'a holder whose CLIENT pid is alive is NOT reclaimable without force (idle protection)');
  liveClient.kill('SIGKILL'); await new Promise(r => liveClient.on('exit', r));
  ok(!isErr(await other.call('choose_identity', { name: 'Carol' })),
     'once the CLIENT pid is dead, the identity is reclaimable');

  await A.close(); await D.close(); await E.close(); await idleHolder.close().catch(() => {}); await other.close();
} finally {
  daemon.kill('SIGTERM');
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
