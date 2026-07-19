// packages/core/test/single-root-policy.test.mjs
// Single-root enforcement (owner #2440): exactly one root per host; every other
// identity is a role under it; NO flat identities; NO second root; enforced silently
// (no prompt/error — the response explains what happened). Drives the BUILT daemon's
// MCP tools over loopback HTTP. Touch points under test:
//   1. create_identity with NO root  → the FIRST identity BECOMES the host root.
//   2. create_identity with a root   → delegated as a ROLE under it (no flat).
//   3. create_root_identity with a root already present → silently a ROLE (no 2nd root,
//      no error) — the interactive path (skip_if_root_exists defaulting false).
//   4. INVARIANT: exactly one root; all others roles.
// (The installer CLI's idempotent skip path — skip_if_root_exists=true — is covered by
//  create-root-cli.test.mjs.)
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
const txt = (r) => (Array.isArray(r.content) ? r.content : []).map((c) => (typeof c.text === 'string' ? c.text : '')).join('\n');

const dir = mkdtempSync(join(tmpdir(), 'a2a-1root-'));
const PORT = await freePort();
const URL_ = `http://127.0.0.1:${PORT}/mcp`;
const daemon = spawn('node', [CLI, 'serve'], { env: { ...process.env, OURS_TRANSPORT: 'http', OURS_PORT: String(PORT), OURS_STATE_DIR: dir, OURS_BROKER_URL: 'wss://invalid.local/none', OURS_API_VISIBILITY: 'open' }, stdio: 'ignore' });
try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/version`)).ok) break; } catch {} await sleep(250); }
  const transport = new StreamableHTTPClientTransport(new URL(URL_));
  const client = new Client({ name: '1root-test', version: '0.0.0' });
  await client.connect(transport);
  const call = (name, args = {}) => client.callTool({ name, arguments: args });

  // 1. create_identity with NO root → becomes the host root.
  const alice = txt(await call('create_identity', { name: 'Alice', expose_local: false }));
  ok(/host ROOT/i.test(alice), '1. first create_identity with no root → becomes the host ROOT');
  ok(!/flat identity/i.test(alice), '1. no "flat identity" language — flat state is not created');
  const idA = txt(await call('list_identities'));
  ok((idA.match(/\(root\)/g) || []).length === 1 && /Alice/.test(idA), '1. list_identities shows exactly one root (Alice)');

  // 2. create_identity WITH a root → role under it.
  const bob = txt(await call('create_identity', { name: 'Bob', expose_local: false }));
  ok(/role under root "Alice"/i.test(bob), '2. create_identity with a root → delegated as a role under Alice');

  // 3. create_root_identity when a root already exists → silently a ROLE (no 2nd root).
  const carol = await call('create_root_identity', { name: 'Carol', expose_local: false });
  const carolTxt = txt(carol);
  ok(!carol.isError, '3. create_root_identity with an existing root does NOT error (silent)');
  ok(/as a ROLE under it/i.test(carolTxt) && /already exists \("Alice"\)/.test(carolTxt), '3. Carol was adopted as a role under the existing root, not a 2nd root');

  // 4. INVARIANT: exactly one root; Bob + Carol are roles.
  const idAll = txt(await call('list_identities'));
  ok((idAll.match(/\(root\)/g) || []).length === 1, '4. still exactly ONE root after all creates');
  ok((idAll.match(/\(role\)/g) || []).length === 2, '4. Bob and Carol are both roles under the one root');
  ok(!/flat/i.test(idAll), '4. no flat identity anywhere');

  await transport.terminateSession(); await client.close();
} finally {
  daemon.kill('SIGTERM');
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
