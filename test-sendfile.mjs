#!/usr/bin/env node
// e2e: send_file / get_files / list_incoming_files round-trip (core 3.1).
// One MCP server process hosts Alice + Bob; Alice sends a file, Bob retrieves it.
// Prereq: broker on ws://localhost:9000, built bundle (cd packages/core && npm run build).
import { spawn } from 'node:child_process';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import * as fs from 'node:fs';

const PLUGIN_DIST = resolve('packages/core/dist/index.js');
const BROKER_URL = 'ws://localhost:9000';
const STATE_DIR = resolve(homedir(), '.ours-sendfile-test');

function createClient() {
  const child = spawn('node', [PLUGIN_DIST], {
    env: { ...process.env, OURS_STATE_DIR: STATE_DIR, OURS_BROKER_URL: BROKER_URL, OURS_TRANSPORT: 'stdio' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '';
  const pending = new Map();
  let nextId = 1;
  child.stderr.on('data', (d) => { if (process.env.VERBOSE) process.stderr.write(`[srv] ${d}`); });
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try { const msg = JSON.parse(line); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } } catch {}
    }
  });
  function send(method, params = {}) {
    return new Promise((res, rej) => {
      const id = nextId++;
      const timer = setTimeout(() => { pending.delete(id); rej(new Error(`${method} timed out`)); }, 40_000);
      pending.set(id, (msg) => { clearTimeout(timer); msg.error ? rej(new Error(`${method} → ${JSON.stringify(msg.error)}`)) : res(msg.result); });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  return {
    child,
    initialize: () => send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test-sendfile', version: '0.0.1' } }),
    call: async (name, args = {}) => { const res = await send('tools/call', { name, arguments: args }); return res?.content?.[0]?.text ?? JSON.stringify(res); },
    kill: () => child.kill('SIGTERM'),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function assert(cond, msg) { if (!cond) throw new Error(`ASSERT FAILED: ${msg}`); console.log(`  ✓ ${msg}`); }

async function main() {
  console.log('=== ours send_file e2e test ===\n');
  fs.rmSync(STATE_DIR, { recursive: true, force: true });
  fs.mkdirSync(STATE_DIR, { recursive: true });

  const c = createClient();
  await c.initialize();

  // --- handshake: Alice <-> Bob ---
  await c.call('create_identity', { name: 'Alice' });
  const invite = await c.call('generate_invite', { name: 'Bob' });
  const blob = invite.match(/\n\n(.+)$/s)?.[1]?.trim();
  assert(!!blob, 'Alice generated an invite blob');
  await c.call('create_identity', { name: 'Bob' });
  await c.call('add_contact', { invite: blob });
  console.log('  waiting 5s for handshake…');
  await sleep(5000);
  await c.call('choose_identity', { name: 'Alice' });
  assert(/Bob/.test(await c.call('list_contacts')), 'Alice learned Bob');

  // --- Alice sends a file to Bob via a filesystem path ---
  const srcPath = join(STATE_DIR, 'src-hello.png');
  const PAYLOAD = Buffer.from('\x89PNG\r\n\x1a\nHELLO-FILE-BYTES');
  fs.writeFileSync(srcPath, PAYLOAD);
  const sent = await c.call('send_file', { contact: 'Bob', path: srcPath });
  assert(/wire_id/.test(sent), 'send_file reports a wire_id');
  const fileWire = (sent.match(/wire_id ([^)\s]+)/) || [])[1];
  assert(!!fileWire, `send_file surfaces the file's wire_id (${fileWire})`);
  await sleep(3000);

  // --- Bob sees metadata, then pulls bytes ---
  await c.call('choose_identity', { name: 'Bob' });
  const listed = await c.call('list_incoming_files');
  assert(/src-hello\.png/.test(listed) && /image\/png/.test(listed), 'list_incoming_files shows the file + inferred mime');

  // wake signal is content-free
  const notif = fs.readFileSync(join(STATE_DIR, 'Bob', 'notifications.log'), 'utf8');
  assert(/file_received/.test(notif) && !/HELLO-FILE-BYTES/.test(notif), 'notifications.log records file_received but NOT the bytes');

  const got = await c.call('get_files');
  assert(/1 new file/.test(got) && /src-hello\.png/.test(got), 'get_files surfaces 1 new file with a path');
  const onDiskPath = (got.match(/(\/[^\s]+src-hello\.png)/) || [])[1];
  assert(!!onDiskPath && fs.existsSync(onDiskPath), 'get_files wrote the file to disk');
  assert(fs.readFileSync(onDiskPath).equals(PAYLOAD), 'received bytes match the source file exactly');
  assert(/No new files/.test(await c.call('get_files')), 'second get_files shows nothing new (file now processed)');

  // --- cross-kind reply: a message replies to the file (shared wire_id namespace) ---
  const reply = await c.call('send_message', { contact: 'Alice', text: 'got your file', reply_to_wire_id: fileWire, reply_to_sentence: 1 });
  assert(/wire_id/.test(reply), 'send_message can reply to a file wire_id');
  await sleep(3000);
  await c.call('choose_identity', { name: 'Alice' });
  assert(/got your file/.test(await c.call('get_messages')), 'Alice received the cross-kind reply');

  // --- restart persistence: processed files survive, are not re-served ---
  c.kill();
  await sleep(1500);
  const c2 = createClient();
  await c2.initialize();
  await c2.call('choose_identity', { name: 'Bob' });
  assert(/src-hello\.png/.test(await c2.call('list_incoming_files')), 'processed file persists across restart (history view)');
  assert(/No new files/.test(await c2.call('get_files')), 'processed file is not re-served after restart');
  c2.kill();

  console.log('\n=== send_file e2e PASSED ===');
}
main().catch((e) => { console.error(e); process.exit(1); });
