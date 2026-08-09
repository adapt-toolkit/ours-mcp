// packages/core/test/resource-updated.test.mjs
// THE INBOX RESOURCE UPDATE REACHES A REAL MCP CLIENT.
//
// serve.ts's pushNotification is the last hop of a chain that now runs through
// the SDK's typed event registry (ours-sdk src/events.ts, the `notification`
// entry): MUFL emits notify_agent → wireHandlers renders a summary →
// process.nextTick → the registry → DaemonOptions.onIdentityNotify with the
// session id resolved AT FIRE TIME → sendResourceUpdated on that session's
// server. Every link in that chain typechecks whether or not it works.
//
// So this test does not inspect types, mocks or logs. It runs the BUILT daemon,
// connects a REAL @modelcontextprotocol/sdk Client, has a second real client
// send a real message, and waits for the protocol notification to arrive on the
// first client's transport. If any link is broken — a lost registration, a sid
// resolved too early, a summary that never fires — nothing arrives and this
// times out.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
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
const freePort = () => new Promise((res, rej) => {
  const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej);
});

async function connector(url, token, pid) {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { 'x-ours-lease-token': token, 'x-ours-client-pid': String(pid) } },
  });
  const client = new Client({ name: `c-${token}`, version: '0.0.0' });
  await client.connect(transport);
  return {
    client,
    call: (name, args = {}) => client.callTool({ name, arguments: args }),
    text: async (name, args = {}) => {
      const r = await client.callTool({ name, arguments: args });
      return (r.content ?? []).map((c) => c.text ?? '').join('\n');
    },
    close: async () => { try { await transport.terminateSession(); } catch { /* going away */ } await client.close(); },
  };
}

const dir = mkdtempSync(join(tmpdir(), 'a2a-resupd-'));
const PORT = await freePort();
const URL_ = `http://127.0.0.1:${PORT}/mcp`;
const daemon = spawn('node', [CLI, 'serve'], {
  env: {
    ...process.env, OURS_TRANSPORT: 'http', OURS_PORT: String(PORT), OURS_STATE_DIR: dir,
    OURS_BROKER_URL: 'wss://invalid.local/none', OURS_API_VISIBILITY: 'open',
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});
const dlog = [];
daemon.stderr.on('data', (b) => { dlog.push(String(b)); });

// A DEADLINE, not a sleep — a healthy run leaves as soon as the condition holds.
const until = async (label, fn, ms = 120_000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() >= deadline) return undefined;
    await sleep(200);
  }
};

try {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/version`)).ok) break; } catch { /* not up yet */ }
    await sleep(250);
  }

  const A = await connector(URL_, 'tokA', process.pid);
  const B = await connector(URL_, 'tokB', process.pid);

  // Collect EVERY resources/updated notification A's transport receives, before
  // anything can produce one. Registering after the send would race the thing
  // under test — the same class of mistake as measuring a state file while the
  // previous write is still in flight.
  const updates = [];
  A.client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
    updates.push(n.params?.uri);
  });

  await A.call('create_identity', { name: 'Alice', expose_local: true, local_auto_accept: true });
  await B.call('create_identity', { name: 'Bob', expose_local: true, local_auto_accept: true });

  const invite = await A.text('generate_invite', { name: 'Bob' });
  const blob = (invite.match(/[A-Za-z0-9_-]{40,}/g) ?? []).sort((x, y) => y.length - x.length)[0];
  ok(Boolean(blob), 'generate_invite returned a redeemable blob');
  await B.call('add_contact', { invite: blob });

  // add_contact resolves when the invite is ACCEPTED; the contact enters
  // list_contacts 8-13 s later. Sending inside that window takes the
  // introduction fallback instead of the direct path.
  const contactSeen = await until('Bob to see Alice in list_contacts', async () => {
    const t = await B.text('list_contacts');
    return /Alice/.test(t) ? t : undefined;
  });
  ok(Boolean(contactSeen), 'Bob sees Alice as a contact');

  const wanted = `ours://inbox/${encodeURIComponent('Alice')}`;

  // MEASURED, NOT ASSUMED, AND NOT "FIXED": the inbox resource is updated on
  // EVERY notify summary, not only on ones that change the inbox — accepting an
  // invite pushes one too. That is the baseline's behaviour (pushNotification
  // has never inspected the event), so it is noise rather than a regression, and
  // quietly narrowing it here would be a behaviour change smuggled in under a
  // test fix. It is named so the next person meets it as a known property.
  // The consequence for THIS test is that "zero updates before the send" is the
  // wrong pre-condition; the right one is a baseline count to measure against,
  // which is also what stops the assertion below passing on leftover noise.
  const before = updates.length;
  ok(before > 0 && updates.every((u) => u === wanted),
    `pre-send updates are the known contact_accepted noise, on the same uri (${before} seen)`);

  await B.call('send_message', { contact: 'Alice', text: 'does the resource update arrive?' });

  const got = await until('the resources/updated notification to reach client A', async () =>
    (updates.length > before ? true : undefined), 90_000);

  ok(got === true,
    `client A received a NEW notifications/resources/updated after the message` +
    (got === true ? '' : ` — saw [${updates.join(', ')}]`));
  ok(updates.slice(before).includes(wanted),
    `and it carries ${wanted}`);

  // The URI must be the one the resource itself hands back, or a client
  // subscribes to a uri nothing ever updates. inboxResourceUri has exactly two
  // callers and this is the check that they still agree.
  const read = await A.client.readResource({ uri: 'ours://inbox' });
  ok(read.contents?.[0]?.uri === wanted,
    `the inbox resource reports the SAME uri the notification carries (${read.contents?.[0]?.uri})`);
  ok(/does the resource update arrive\?/.test(read.contents?.[0]?.text ?? ''),
    'and reading it returns the message the notification announced');

  await A.close();
  await B.close();
} finally {
  // Only on failure. pushNotification's two "no resource update sent" lines are
  // what tell you WHICH link broke — an unregistered server, or no bound session
  // — and without them a red run here is just "nothing arrived".
  if (fail > 0) {
    console.log('--- daemon notify/routing lines ---');
    console.log(dlog.join('').split('\n')
      .filter((l) => /notify:|no bound session|no MCP server registered/.test(l))
      .slice(-25).join('\n'));
  }
  daemon.kill('SIGTERM');
  await sleep(500);
  daemon.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
