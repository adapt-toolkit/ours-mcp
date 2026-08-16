import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'dist', 'cli.js');
const BROKER = 'ws://127.0.0.1:1/no-broker';

console.log('startup-cli\n');

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function runStart(extraEnv = {}) {
  const state = mkdtempSync(join(tmpdir(), 'ours-startup-cli-'));
  const port = await freePort();
  const startedAt = Date.now();
  const env = { ...process.env };
  // The host running this suite may itself use ours. Prove owner-mode token
  // persistence/order without inheriting its live daemon token or config.
  delete env.OURS_API_TOKEN;
  delete env.OURS_API_VISIBILITY;
  delete env.OURS_CONFIG;
  Object.assign(env, {
    OURS_STATE_DIR: state,
    OURS_PORT: String(port),
    OURS_BROKER_URL: BROKER,
    OURS_TEST_STARTUP_HEARTBEAT_MS: '100',
    OURS_TEST_STARTUP_POLL_MS: '50',
    OURS_TEST_STARTUP_INACTIVITY_MS: '5000',
    OURS_TEST_STARTUP_ABSOLUTE_MS: '20000',
    ...extraEnv,
  });
  const run = spawnSync(process.execPath, [CLI, 'start'], {
    encoding: 'utf8',
    timeout: 30_000,
    env,
  });
  const elapsedMs = Date.now() - startedAt;

  let progress = null;
  let pid = null;
  let token = '';
  let tokenMode = null;
  let controlStatus = null;
  try { progress = JSON.parse(readFileSync(join(state, 'startup-progress.json'), 'utf8')); } catch {}
  try { pid = Number(readFileSync(join(state, 'daemon.pid'), 'utf8')); } catch {}
  try {
    const tokenPath = join(state, 'daemon-token');
    token = readFileSync(tokenPath, 'utf8').trim();
    tokenMode = statSync(tokenPath).mode & 0o777;
  } catch {}
  try {
    const probeToken = token || extraEnv.OURS_API_TOKEN || '';
    controlStatus = (
      await fetch(`http://127.0.0.1:${port}/identities`, {
        headers: probeToken ? { 'x-ours-api-token': probeToken } : {},
      })
    ).status;
  } catch {}
  if (pid) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
    await new Promise((resolve) => setTimeout(resolve, 300));
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
  rmSync(state, { recursive: true, force: true });
  return { ...run, exitStatus: run.status, elapsedMs, progress, token, tokenMode, controlStatus };
}

{
  const result = await runStart();
  assert.equal(result.exitStatus, 0, result.stderr);
  assert.match(result.stdout, /ours-mcp is up/);
  assert.equal(result.progress?.phase, 'ready');
  assert(result.token.length >= 32, 'owner token exists before start returns');
  assert.equal(result.tokenMode, 0o600);
  assert.equal(result.controlStatus, 200, 'protected control route is usable before start returns');
}
console.log('  ✓ zero-identity startup waits for persisted owner auth + protected control readiness');

{
  const result = await runStart({ OURS_API_VISIBILITY: 'open' });
  assert.equal(result.exitStatus, 0, result.stderr);
  assert.equal(result.token, '', 'open mode does not mint an owner token');
  assert.equal(result.controlStatus, 200, 'open control route is ready without auth');
}
console.log('  ✓ open mode readiness preserves the intentionally unauthenticated control surface');

{
  const sharedToken = 'startup-shared-token-placeholder-0123456789';
  const result = await runStart({
    OURS_API_VISIBILITY: 'shared',
    OURS_API_TOKEN: sharedToken,
  });
  assert.equal(result.exitStatus, 0, result.stderr);
  assert.equal(result.token, '', 'shared mode does not persist the operator token');
  assert.equal(result.controlStatus, 200, 'shared control route is ready with the explicit token');
}
console.log('  ✓ shared mode readiness uses the explicit token without persisting it');

{
  const result = await runStart({
    OURS_TEST_FAKE_RESTORE_COUNT: '4',
    OURS_TEST_FAKE_RESTORE_MS: '200',
  });
  assert.equal(result.exitStatus, 0, result.stderr);
  assert.match(result.stderr, /startup: Restoring identities 0\/4/);
  assert.match(result.stderr, /startup: Restoring identities [1-4]\/4/);
  assert.doesNotMatch(result.stderr, /identity\.key|state_data|container|\/tmp\//);
}
console.log('  ✓ non-TTY slow/many fake restoration emits stable count-only n/N lines');

{
  // The claim: when the daemon is alive but logically STUCK IN A PHASE, the absolute
  // bound expires and the error names THAT phase.
  //
  // The bound is measured from process start, so it races the daemon's own boot —
  // Initializing daemon → Starting protocol runtime → Starting local contact book →
  // Restoring identities. This case used a 6s bound against a 10s stall, which left
  // barely 1.6x for boot to reach the restore phase. On a loaded CI runner it did not:
  // the bound expired at "Starting local contact book" and the assertion on WHICH
  // phase was reported failed, while every behavioural claim was still true.
  //
  // Fixed by removing the competition rather than by loosening the assertion. The
  // stall now dominates the bound by ~33x, so the phase the bound expires in is the
  // restore phase for any boot that completes at all — and a boot slower than
  // ABSOLUTE_MS would already have failed the cases above, which run on the harness's
  // own 20s default. Every assertion is preserved, and the expected duration is
  // derived from the constant so the two cannot drift apart.
  const ABSOLUTE_MS = 18_000;
  const result = await runStart({
    OURS_TEST_FAKE_RESTORE_COUNT: '1',
    OURS_TEST_FAKE_RESTORE_MS: '600000',
    OURS_TEST_STARTUP_ABSOLUTE_MS: String(ABSOLUTE_MS),
  });
  assert.equal(result.exitStatus, 1);
  assert.match(result.stderr, new RegExp(`startup did not finish within ${ABSOLUTE_MS / 1000}s`));
  assert.match(result.stderr, /Last phase: Restoring identities 0\/1/);
  assert.match(result.stderr, /bounded wait expired/i);
}
console.log('  ✓ a live-but-logically-stalled daemon fails at the absolute bound');

{
  const result = await runStart({
    OURS_TEST_STARTUP_FAIL: '1',
    OURS_TEST_STARTUP_INACTIVITY_MS: '2000',
    OURS_TEST_STARTUP_ABSOLUTE_MS: '5000',
  });
  assert.equal(result.exitStatus, 1);
  assert.match(result.stderr, /daemon exited before becoming ready/);
  assert(result.elapsedMs < 2_000, `immediate failure took ${result.elapsedMs}ms`);
}
console.log('  ✓ an immediate daemon failure stays nonzero and returns promptly');
