#!/usr/bin/env node
// Exclusive-binding / force-eviction test (HTTP, two real sessions).
// Proves: an identity binds to at most one session; a second session is declined
// without force; force=true evicts the prior holder, whose next per-container
// call returns a clean "reassigned" error.
//
// Prereq: broker on ws://localhost:9000, built bundle.

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import * as fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const PLUGIN_DIST = resolve('packages/core/dist/index.js');
const PORT = 3099;
const STATE_DIR = resolve(homedir(), '.ours-evict-test');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function assert(cond, msg) { if (!cond) throw new Error(`ASSERT FAILED: ${msg}`); console.log(`  ✓ ${msg}`); }

async function connect() {
  const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`));
  const client = new Client({ name: 'evict-test', version: '0.0.1' }, { capabilities: {} });
  await client.connect(transport);
  return client;
}
async function call(client, name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  return res?.content?.[0]?.text ?? JSON.stringify(res);
}

async function main() {
  console.log('=== ours exclusive-binding / eviction test ===\n');
  fs.rmSync(STATE_DIR, { recursive: true, force: true });

  const srv = spawn('node', [PLUGIN_DIST], {
    env: { ...process.env, OURS_STATE_DIR: STATE_DIR, OURS_BROKER_URL: 'ws://localhost:9000', OURS_TRANSPORT: 'http', OURS_PORT: String(PORT) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let ready = false;
  srv.stderr.on('data', (d) => { if (/ready \(transport=http/.test(d.toString())) ready = true; if (process.env.VERBOSE) process.stderr.write(`[srv] ${d}`); });
  for (let i = 0; i < 60 && !ready; i++) await sleep(500);
  if (!ready) throw new Error('server did not become ready');
  await sleep(500);

  try {
    const a = await connect();
    const b = await connect();

    assert(/Created identity "Shared"/.test(await call(a, 'create_identity', { name: 'Shared' })), 'session A created + bound Shared');
    assert(/Bound to "Shared"/.test(await call(a, 'current_identity')), 'session A is bound to Shared');

    const declined = await call(b, 'choose_identity', { name: 'Shared' });
    assert(/another session/.test(declined), 'session B is declined without force');

    // A still works.
    assert(/No contacts/.test(await call(a, 'list_contacts')), 'session A still operates on Shared before eviction');

    const forced = await call(b, 'choose_identity', { name: 'Shared', force: true });
    assert(/Bound to identity "Shared"/.test(forced), 'session B takes over with force=true');

    // A's next per-container call must fail cleanly with a reassigned error.
    const evicted = await call(a, 'list_contacts');
    assert(/reassigned/.test(evicted), "session A's next call returns a clean 'reassigned' error");

    // B now operates on Shared.
    assert(/No contacts/.test(await call(b, 'list_contacts')), 'session B operates on Shared after takeover');

    await a.close();
    await b.close();
    console.log('\n=== EVICTION TEST PASSED ===');
  } finally {
    srv.kill('SIGTERM');
    await sleep(800);
  }
}

main().catch((err) => { console.error('\nEVICTION TEST FAILED:', err.message); process.exitCode = 1; });
