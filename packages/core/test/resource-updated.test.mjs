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
import { connectConnector } from './fixtures/connector-client.mjs';
import { LoggingMessageNotificationSchema, ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
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

async function connector(_url, token, pid) {
  // Spawns the REAL connector: the resource update now travels
  // daemon notifications endpoint -> connector -> this stdio client, and that whole
  // chain is what this test exists to prove.
  const c = await connectConnector({ port: PORT, stateDir: dir, leaseToken: token, clientPid: pid });
  return {
    client: c.client,
    call: (n, a = {}) => c.call(n, a),
    text: async (n, a = {}) => c.txt(await c.call(n, a)),
    close: c.close,
  };
}

const dir = mkdtempSync(join(tmpdir(), 'a2a-resupd-'));
const PORT = await freePort();
const URL_ = `http://127.0.0.1:${PORT}`;
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

  // THE SECOND CHANNEL. pushNotification sends TWO notifications per event —
  // notifications/message carrying the summary itself, then
  // notifications/resources/updated saying only "the inbox changed". The SDK
  // conversion dropped the first and kept the second, and no assertion here
  // noticed, because a client watching only resources cannot tell. Collected on
  // the same client and asserted below alongside the resource update, so the two
  // can never again be lost one at a time.
  // No logging/setLevel call is needed: with no level set for the session,
  // Server.isMessageIgnored is false, so every level is delivered.
  const logs = [];
  A.client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => {
    logs.push(n.params);
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
  // THE NOISE THIS ASSERTION USED TO REQUIRE IS GONE, AND ON PURPOSE.
  //
  // It used to read `before > 0`, because pushNotification fired an inbox resource
  // update for EVERY notify summary — including accepting an invite, which does not
  // change the inbox. The comment here called it noise and said narrowing it would
  // be "a behaviour change smuggled in under a test fix". It is not smuggled now:
  // the connector watches `?kinds=inbound`, so contact_accepted no longer announces
  // a change to a resource it did not change. The assertion is inverted rather than
  // deleted, so the improvement is pinned and cannot silently regress into noise.
  const before = updates.length;
  const logsBefore = logs.length;
  ok(before === 0,
    `no pre-send inbox updates: contact_accepted is filtered out daemon-side (${before} seen)`);

  await B.call('send_message', { contact: 'Alice', text: 'does the resource update arrive?' });

  const got = await until('the resources/updated notification to reach client A', async () =>
    (updates.length > before ? true : undefined), 90_000);

  ok(got === true,
    `client A received a NEW notifications/resources/updated after the message` +
    (got === true ? '' : ` — saw [${updates.join(', ')}]`));
  ok(updates.slice(before).includes(wanted),
    `and it carries ${wanted}`);

  // …and the OTHER half of the same push. The resource update says the inbox
  // changed; this is the only channel that says WHAT changed, which is what an
  // MCP client surfaces to a user or an agent.
  const gotLog = await until('the notifications/message summary to reach client A', async () =>
    (logs.length > logsBefore ? true : undefined), 30_000);
  ok(gotLog === true,
    'client A also received a NEW notifications/message — both pushes fire, not one' +
    (gotLog === true ? '' : ` — saw ${logs.length} log notification(s) total`));
  const fresh = logs.slice(logsBefore);
  ok(fresh.some((p) => p?.logger === 'ours' && p?.level === 'info' && /new message from Bob/.test(String(p?.data ?? ''))),
    'the summary names the sender, on logger "ours" at level "info" (baseline index.ts:2169 payload)');

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
