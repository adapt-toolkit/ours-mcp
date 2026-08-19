// test/env-bind-identity.test.mjs
//
// OURS_BIND_IDENTITY: can a supervisor say which identity a session starts on,
// without the MODEL performing the bind?
//
// A fleet role's first boot bound nothing. The briefing told the agent to call
// choose_identity itself — a deterministic step handed to a non-deterministic
// actor, which pays a round trip, can get the name wrong, and on a wake-up where
// those instructions have fallen out of context has nothing naming the identity
// at all. The supervisor already knows the name; this is the input that lets it
// say so.
//
// ----- WHAT MUST NOT REGRESS -----------------------------------------------
// The seeded bind is PLAIN. It is exactly the bind `choose_identity` performs
// with force=false, so it inherits that path's refusal: a LIVE session holding
// the identity is never evicted. Section 4 is the one that matters — it is the
// reason this input is safe to hand a supervisor at all. If it ever starts
// passing for the wrong reason, an environment variable has become a
// remote-eviction primitive.
//
// ----- WHY EVERY SESSION HERE OWNS A SEPARATE `sleep` CHILD -----------------
// A lease is reclaimable only when its CLIENT's pid is dead (the client is the
// harness, not the connector — see connector-client.mjs). Every connector in one
// test file would otherwise inherit the same client pid, this test process's,
// which stays alive for the whole run — so "the previous session went away" would
// be inexpressible and a passing bind would prove nothing. Each session gets a
// real pid this test can kill, which is exactly the shape of an idle harness that
// died.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';

import { connectConnector, spawnDaemon, waitForDaemon } from './fixtures/connector-client.mjs';

const freePort = () => new Promise((resolve, reject) => {
  const s = createServer();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A live process whose pid stands in for a harness. `end()` makes it dead. */
const fakeClient = () => {
  const child = spawn('sleep', ['300'], { stdio: 'ignore' });
  // `exited` must be latched: 'exit' fires ONCE, so a second end() awaiting it
  // would wait forever — and the cleanup in `finally` ends every client again.
  let exited = false;
  child.once('exit', () => { exited = true; });
  return {
    pid: child.pid,
    end: async () => {
      if (exited) return;
      child.kill('SIGKILL');
      await new Promise((r) => (exited ? r() : child.once('exit', r)));
    },
  };
};

const port = await freePort();
const stateDir = mkdtempSync(join(tmpdir(), 'ours-envbind-'));
const daemon = spawnDaemon(port, stateDir);
const clients = [];

let failures = 0;
const ok = (cond, what) => { if (cond) console.log(`  ok  ${what}`); else { failures++; console.log(`  FAIL ${what}`); } };

try {
  await waitForDaemon(port);

  // ── 1. an identity exists, created by an earlier session that is now gone ──
  const makerClient = fakeClient(); clients.push(makerClient);
  const maker = await connectConnector({
    port, stateDir, leaseToken: 'session-maker', clientPid: makerClient.pid,
  });
  const created = maker.txt(await maker.call('create_identity', { name: 'Ana', expose_local: false }));
  ok(/Ana/.test(created), `an identity to bind exists (${created.slice(0, 48)}…)`);
  await maker.close();
  // The lease is deliberately NOT released on close (see connector.ts), so the
  // only thing that frees Ana is the client dying.
  await makerClient.end();

  // ── 2. a NEW session, a NEW lease token, and no bind call at all ───────────
  const seededClient = fakeClient(); clients.push(seededClient);
  const seeded = await connectConnector({
    port, stateDir, leaseToken: 'session-seeded', clientPid: seededClient.pid,
    env: { OURS_BIND_IDENTITY: 'Ana' },
  });
  const bound = seeded.txt(await seeded.call('current_identity'));
  ok(/Bound to "Ana"/.test(bound),
    `OURS_BIND_IDENTITY binds at startup with no tool call from the model (${bound.slice(0, 64)}…)`);
  await seeded.close();
  await seededClient.end();

  // ── 3. a name that does not exist must not stop the session ───────────────
  // A role whose identity has not been created yet has to boot and reach the
  // step in its own instructions that creates it. Unbound is the right outcome;
  // a dead connector is not.
  const missingClient = fakeClient(); clients.push(missingClient);
  const missing = await connectConnector({
    port, stateDir, leaseToken: 'session-missing', clientPid: missingClient.pid,
    env: { OURS_BIND_IDENTITY: 'Nobody' },
  });
  const unbound = missing.txt(await missing.call('current_identity'));
  ok(!/Bound to/.test(unbound),
    `an unknown identity leaves the session unbound rather than failing to start (${unbound.slice(0, 60)}…)`);
  ok(/Ana/.test(missing.txt(await missing.call('list_identities'))),
    'and the session is otherwise fully usable');
  await missing.close();
  await missingClient.end();

  // ── 4. THE CONTROL: a live holder is never evicted ────────────────────────
  const holderClient = fakeClient(); clients.push(holderClient);
  const holder = await connectConnector({
    port, stateDir, leaseToken: 'session-holder', clientPid: holderClient.pid,
    env: { OURS_BIND_IDENTITY: 'Ana' },
  });
  ok(/Bound to "Ana"/.test(holder.txt(await holder.call('current_identity'))),
    'a holder session is bound to Ana, and its client stays alive');

  const intruderClient = fakeClient(); clients.push(intruderClient);
  const intruder = await connectConnector({
    port, stateDir, leaseToken: 'session-intruder', clientPid: intruderClient.pid,
    env: { OURS_BIND_IDENTITY: 'Ana' },
  });
  const stolen = intruder.txt(await intruder.call('current_identity'));
  ok(!/Bound to/.test(stolen),
    `a seeded bind against a LIVE holder is declined, not forced (${stolen.slice(0, 60)}…)`);
  ok(/Bound to "Ana"/.test(holder.txt(await holder.call('current_identity'))),
    'and the live holder is STILL bound — the seed cannot evict a live session');

  await intruder.close();
  await holder.close();
} finally {
  for (const c of clients) await c.end().catch(() => {});
  daemon.kill('SIGTERM');
  await sleep(300);
  rmSync(stateDir, { recursive: true, force: true });
}

if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
