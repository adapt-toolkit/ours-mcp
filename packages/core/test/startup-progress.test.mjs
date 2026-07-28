import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  STARTUP_PROGRESS_FILENAME,
  createStartupProgressReporter,
  readStartupProgress,
  renderStartupProgress,
  waitForStartup,
} from '../dist/startup-progress.js';

console.log('startup-progress\n');

const state = mkdtempSync(join(tmpdir(), 'ours-startup-progress-'));
try {
  let wall = 1_000;
  const reporter = createStartupProgressReporter(state, {
    pid: 4242,
    heartbeatMs: 60_000,
    now: () => wall,
  });
  wall += 10;
  reporter.update('identities', { completed: 3, total: 7 });

  const progress = readStartupProgress(state);
  assert.equal(progress?.pid, 4242);
  assert.equal(progress?.phase, 'identities');
  assert.equal(progress?.completed, 3);
  assert.equal(progress?.total, 7);
  assert.equal(statSync(join(state, STARTUP_PROGRESS_FILENAME)).mode & 0o777, 0o600);
  assert.deepEqual(
    Object.keys(JSON.parse(readFileSync(join(state, STARTUP_PROGRESS_FILENAME), 'utf8'))).sort(),
    ['bootId', 'completed', 'phase', 'pid', 'startedAt', 'total', 'updatedAt', 'version'],
    'structured status contains only the public phase/count contract',
  );

  assert.equal(renderStartupProgress(progress, false), 'startup: Restoring identities 3/7\n');
  assert.equal(
    renderStartupProgress(progress, true),
    '\rstartup: Restoring identities 3/7\x1b[K',
    'TTY rendering updates one line',
  );

  writeFileSync(join(state, STARTUP_PROGRESS_FILENAME), '{"pid":"secret-path"}\n');
  assert.equal(readStartupProgress(state), null, 'malformed or partial status is ignored');
  reporter.failed();
} finally {
  rmSync(state, { recursive: true, force: true });
}
console.log('  ✓ structured status is atomic/public-safe and TTY/non-TTY rendering is stable');

function fakeProgress(pid, now, phase = 'identities', completed = 0, total = 12) {
  return {
    version: 1,
    pid,
    bootId: `${pid}-0`,
    phase,
    completed,
    total,
    startedAt: 0,
    updatedAt: now,
  };
}

{
  // A two-minute restore keeps emitting daemon-owned heartbeats/count changes.
  // This is the production policy exercised with a fake clock, not a shortened
  // alternate timeout.
  let now = 0;
  const seen = [];
  const result = await waitForStartup({
    pid: 10,
    absoluteMs: 180_000,
    inactivityMs: 30_000,
    pollMs: 5_000,
    now: () => now,
    sleep: async (ms) => { now += ms; },
    isReady: async () => now >= 125_000,
    isProcessAlive: () => true,
    readProgress: () => fakeProgress(10, now, 'identities', Math.min(12, Math.floor(now / 10_000)), 12),
    onProgress: (p) => seen.push(p.completed),
  });
  assert.equal(result.ok, true);
  assert.equal(result.elapsedMs, 125_000);
  assert(seen.includes(12), 'n/N progress reaches the final identity before readiness');
}
console.log('  ✓ healthy startup beyond two minutes succeeds while progress remains active');

{
  let now = 0;
  const result = await waitForStartup({
    pid: 11,
    absoluteMs: 180_000,
    inactivityMs: 30_000,
    pollMs: 5_000,
    now: () => now,
    sleep: async (ms) => { now += ms; },
    isReady: async () => false,
    isProcessAlive: () => true,
    // A live event loop can heartbeat forever, but the absolute bound still wins.
    readProgress: () => fakeProgress(11, now, 'reconciliation', 0, 0),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'absolute-timeout');
  assert.equal(result.elapsedMs, 180_000);
}
console.log('  ✓ a logically stalled daemon cannot extend the absolute three-minute bound');

{
  let now = 0;
  const frozen = fakeProgress(12, 0, 'wrapper', 0, 0);
  const result = await waitForStartup({
    pid: 12,
    absoluteMs: 180_000,
    inactivityMs: 30_000,
    pollMs: 5_000,
    now: () => now,
    sleep: async (ms) => { now += ms; },
    isReady: async () => false,
    isProcessAlive: () => true,
    readProgress: () => frozen,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'inactivity-timeout');
  assert.equal(result.elapsedMs, 30_000);
}
console.log('  ✓ a frozen reporter fails on the shorter inactivity bound');

{
  let now = 0;
  const result = await waitForStartup({
    pid: 13,
    absoluteMs: 180_000,
    inactivityMs: 30_000,
    pollMs: 5_000,
    now: () => now,
    sleep: async (ms) => { now += ms; },
    isReady: async () => false,
    isProcessAlive: () => false,
    readProgress: () => null,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'process-exited');
  assert.equal(result.elapsedMs, 0);
}
console.log('  ✓ immediate daemon exit fails immediately');
