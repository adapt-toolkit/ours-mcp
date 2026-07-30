// Unit tests for plugin/ours-monitor.impl.mjs (the implementation module — plugin/ours-
// monitor.mjs itself is a thin loader-shape file re-exported as `server`/default only; see its
// header comment for why that split exists).
// Everything here mocks spawnWatch (the Bun.spawn-based watcher) and `client` (the OpenCode SDK
// client) — no real process, no real HTTP call, no real model turn. That's deliberate: this
// suite proves OUR code's logic (rate limiting, line classification, the start/stop/dispose
// lifecycle, a rate-limit trip disarming rather than looping forever). The REAL watcher mechanics
// — does Bun.spawn + incremental stream reading actually deliver lines from a real, never-exiting
// `ours-mcp watch` process; does a real model turn actually get injected and reply — are proven
// for real in test/ours-monitor-live-watch.test.mjs, since a mock never has to behave like the
// real, long-running child process it stands in for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  createRateLimiter,
  classifyLine,
  buildInjectionText,
  watchCommandArgv,
  createMonitorRegistry,
  createOursMonitorPlugin,
  DEFAULT_RATE_LIMIT_MAX,
} from '../plugin/ours-monitor.impl.mjs';

const PLUGIN_DIR = join(dirname(dirname(fileURLToPath(import.meta.url))), 'plugin');

// ---------------------------------------------------------------------------
// REQUIRED (regression guard) — the file OpenCode's `plugin` config key actually loads must
// export ONLY `server`/default. A module exporting `server` PLUS other named consts/functions
// still trips OpenCode's tier-2 loader fallback (iterates every export, throws on the first
// non-function). This test can't run the real loader, but it CAN catch a regression back to the
// broken shape cheaply, on every run, without needing the real binary.
// ---------------------------------------------------------------------------

test('REQUIRED (regression guard) — plugin/ours-monitor.mjs (the real loader entry) exports ONLY server + default, nothing else', async () => {
  const source = readFileSync(join(PLUGIN_DIR, 'ours-monitor.mjs'), 'utf8');
  const exportedNames = [...source.matchAll(/^export\s+(?:const|function|class|let|var)\s+([A-Za-z0-9_$]+)/gm)].map((m) => m[1]);
  assert.deepEqual(exportedNames.sort(), ['server'], 'ours-monitor.mjs must export exactly one named export ("server") — any other export causes OpenCode\'s loader to throw');
  assert.match(source, /export default server/, 'must also have a default export pointing at the same server');

  const mod = await import(join(PLUGIN_DIR, 'ours-monitor.mjs'));
  assert.deepEqual(Object.keys(mod).sort(), ['default', 'server']);
  assert.equal(typeof mod.server, 'function', 'server must itself be a function (an OpenCode Plugin: PluginInput => Promise<Hooks>)');
  assert.equal(mod.default, mod.server);
});

// ---------------------------------------------------------------------------
// REQUIRED (regression guards) — defaultSpawnWatch pipes stderr but MUST continuously read it,
// or the OS pipe backs up (~64KB) and the child blocks on its next write — the exact
// silent-non-reactivity failure this plugin exists to prevent, just moved to stderr.
// defaultSpawnWatch itself needs a real Bun runtime to invoke (Bun.spawn is undefined under
// node:test) — the REAL, live proof that it doesn't deadlock against a real child lives in
// test/ours-monitor-live-watch.test.mjs (runs under real Bun, no model/billing dependency). These
// two are the cheap, always-on regression guards: a source check that the drain code is still
// there, and a mock check that the plugin always threads `log` through to spawnWatch (the wiring
// stderr draining depends on — without it, defaultSpawnWatch would have nothing to log stderr to).
// ---------------------------------------------------------------------------

test('REQUIRED (regression guard) — defaultSpawnWatch drains stderr, not just stdout', () => {
  const source = readFileSync(join(PLUGIN_DIR, 'ours-monitor.impl.mjs'), 'utf8');
  const fnMatch = source.match(/export function defaultSpawnWatch[\s\S]*?\n}\n/);
  assert.ok(fnMatch, 'defaultSpawnWatch not found in ours-monitor.impl.mjs');
  const fnSource = fnMatch[0];
  assert.match(fnSource, /proc\.stderr/, 'defaultSpawnWatch must read proc.stderr, not just proc.stdout, or the pipe backs up and deadlocks the child');
  assert.match(fnSource, /stderr:\s*['"]pipe['"]/, 'stderr must be piped (not inherited) so it CAN be drained into the log');
});

test('REQUIRED (regression guard) — the plugin always passes `log` to spawnWatch, so a real spawnWatch has somewhere to send drained stderr', async () => {
  const calls = [];
  const spawnWatch = (identity, log) => { calls.push({ identity, log }); return fakeHangingSpawnWatch(1)()  ; };
  const plugin = createOursMonitorPlugin({ log: () => {}, killProcess: () => {}, spawnWatch });
  const hooks = await plugin({ client: fakeClient(async () => ({ response: { status: 204 } })), directory: '/proj' });
  await hooks.tool.ours_monitor_start.execute({ identity: 'Dev' }, { sessionID: 's1' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].identity, 'Dev');
  assert.equal(typeof calls[0].log, 'function', 'spawnWatch must receive a real log function as its 2nd arg');
});

// ---------------------------------------------------------------------------
// createRateLimiter — pure, deterministic (fake `now`)
// ---------------------------------------------------------------------------

test('rate limiter allows up to `max` within the window, then trips and stays disarmed', () => {
  let t = 0;
  const limiter = createRateLimiter({ max: 3, windowMs: 1000, now: () => t });

  assert.deepEqual(limiter.recordAndCheck(), { allowed: true, justDisarmed: false });
  assert.deepEqual(limiter.recordAndCheck(), { allowed: true, justDisarmed: false });
  assert.deepEqual(limiter.recordAndCheck(), { allowed: true, justDisarmed: false });
  // 4th call within the same instant trips it.
  assert.deepEqual(limiter.recordAndCheck(), { allowed: false, justDisarmed: true });
  assert.equal(limiter.isDisarmed(), true);

  // Once disarmed, EVERY subsequent call is suppressed, and only the trip itself reports
  // justDisarmed:true; it never re-reports or re-arms on its own.
  for (let i = 0; i < 10; i++) {
    assert.deepEqual(limiter.recordAndCheck(), { allowed: false, justDisarmed: false });
  }
  assert.equal(limiter.isDisarmed(), true);
});

test('rate limiter: old timestamps age out of the sliding window, freeing up capacity', () => {
  let t = 0;
  const limiter = createRateLimiter({ max: 2, windowMs: 100, now: () => t });
  assert.equal(limiter.recordAndCheck().allowed, true); // t=0
  assert.equal(limiter.recordAndCheck().allowed, true); // t=0
  assert.equal(limiter.recordAndCheck().allowed, false); // t=0, 3rd — trips
  assert.equal(limiter.isDisarmed(), true);
});

test('rate limiter: a FRESH instance is not affected by a previously-disarmed one (per ours_monitor_start call)', () => {
  let t = 0;
  const a = createRateLimiter({ max: 1, windowMs: 1000, now: () => t });
  a.recordAndCheck();
  assert.equal(a.recordAndCheck().allowed, false);
  assert.equal(a.isDisarmed(), true);

  const b = createRateLimiter({ max: 1, windowMs: 1000, now: () => t });
  assert.equal(b.isDisarmed(), false);
  assert.equal(b.recordAndCheck().allowed, true);
});

test('rate limiter: ticks spaced OUTSIDE the window never trip it, however many there are', () => {
  let t = 0;
  const limiter = createRateLimiter({ max: 2, windowMs: 100, now: () => t });
  for (let i = 0; i < 20; i++) {
    t += 200; // always outside the 100ms window
    const r = limiter.recordAndCheck();
    assert.equal(r.allowed, true, `tick ${i} at t=${t} should be allowed (window already emptied)`);
  }
  assert.equal(limiter.isDisarmed(), false);
});

// ---------------------------------------------------------------------------
// classifyLine — tick vs. blank. Bun.spawn gives proc.pid synchronously, so there is no PID
// line in the stream to parse — every non-blank line from `ours-mcp watch` is a real new-mail
// tick.
// ---------------------------------------------------------------------------

test('classifyLine: blank/whitespace-only lines are always "blank"', () => {
  assert.deepEqual(classifyLine(''), { kind: 'blank' });
  assert.deepEqual(classifyLine('   '), { kind: 'blank' });
  assert.deepEqual(classifyLine('\n'), { kind: 'blank' });
  assert.deepEqual(classifyLine(undefined), { kind: 'blank' });
});

test('classifyLine: any non-blank line is a tick, numeric or not', () => {
  assert.deepEqual(classifyLine('new mail for Dev'), { kind: 'tick', line: 'new mail for Dev' });
  assert.deepEqual(classifyLine('99999'), { kind: 'tick', line: '99999' });
  assert.deepEqual(classifyLine('  padded  '), { kind: 'tick', line: 'padded' });
});

// ---------------------------------------------------------------------------
// watchCommandArgv / buildInjectionText — pure descriptions
// ---------------------------------------------------------------------------

test('watchCommandArgv: identity is a discrete argv element passed straight to Bun.spawn, no shell involved', () => {
  const argv = watchCommandArgv('Dev; rm -rf /');
  assert.deepEqual(argv, ['ours-mcp', 'watch', 'Dev; rm -rf /']);
});

test('buildInjectionText: mentions the identity and the line, and tells the agent to use get_messages', () => {
  const text = buildInjectionText('Dev', 'new mail');
  assert.match(text, /"Dev"/);
  assert.match(text, /new mail/);
  assert.match(text, /get_messages/);
});

// ---------------------------------------------------------------------------
// createMonitorRegistry — plain per-session state map
// ---------------------------------------------------------------------------

test('createMonitorRegistry: isolated per instance, get/set/delete/entries work as a Map would', () => {
  const reg = createMonitorRegistry();
  assert.equal(reg.get('s1'), undefined);
  reg.set('s1', { identity: 'Dev' });
  assert.deepEqual(reg.get('s1'), { identity: 'Dev' });
  assert.equal([...reg.entries()].length, 1);
  reg.delete('s1');
  assert.equal(reg.get('s1'), undefined);

  const other = createMonitorRegistry();
  assert.equal(other.get('s1'), undefined, 'a second registry instance is independent');
});

// ---------------------------------------------------------------------------
// createOursMonitorPlugin — the full tool lifecycle, with spawnWatch and client fully mocked
// ---------------------------------------------------------------------------

// A fake spawnWatch matching the real defaultSpawnWatch's shape: { pid, lines() }, pid known
// SYNCHRONOUSLY (Bun.spawn makes proc.pid available at spawn time, so no PID-capture race is
// possible), lines() an async generator of raw lines.
function fakeSpawnWatch(pid, lines) {
  return () => ({
    pid,
    lines: async function* () {
      for (const l of lines) yield l;
    },
  });
}

function fakeHangingSpawnWatch(pid) {
  return () => ({
    pid,
    lines: () => (async function* () {
      yield* []; // no lines, ever
      await new Promise(() => {}); // never resolves — the loop just parks
    })(),
  });
}

function fakeClient(promptAsyncImpl) {
  return { session: { promptAsync: promptAsyncImpl } };
}

async function flushMicrotasks(n = 20) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

test('ours_monitor_start: returns immediately (does not await the watcher loop), and pid is captured SYNCHRONOUSLY at start', async () => {
  const registry = createMonitorRegistry();
  const spawnWatch = fakeHangingSpawnWatch(1000);
  const plugin = createOursMonitorPlugin({ registry, log: () => {}, killProcess: () => {}, spawnWatch });
  const hooks = await plugin({ client: fakeClient(async () => ({ response: { status: 204 } })), directory: '/tmp' });

  const result = await Promise.race([
    hooks.tool.ours_monitor_start.execute({ identity: 'Dev' }, { sessionID: 's1' }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('execute() did not return promptly — watcher loop is blocking it')), 500)),
  ]);
  assert.match(result.output, /Watching ours mail/);
  // pid is known the INSTANT start() returns — no flushMicrotasks(), no waiting for a line to
  // arrive.
  assert.equal(registry.get('s1').pid, 1000);
});

test('ours_monitor_start -> tick -> injects via client.session.promptAsync with the right sessionID/identity', async () => {
  const injected = [];
  const spawnWatch = fakeSpawnWatch(4242, ['new mail line']);
  const plugin = createOursMonitorPlugin({ log: () => {}, killProcess: () => {}, spawnWatch });
  const hooks = await plugin({
    client: fakeClient(async (args) => { injected.push(args); return { response: { status: 204 } }; }),
    directory: '/proj',
  });

  await hooks.tool.ours_monitor_start.execute({ identity: 'Dev' }, { sessionID: 's1' });
  await flushMicrotasks();

  assert.equal(injected.length, 1);
  assert.equal(injected[0].path.id, 's1');
  assert.equal(injected[0].query.directory, '/proj');
  assert.match(injected[0].body.parts[0].text, /"Dev"/);
  assert.match(injected[0].body.parts[0].text, /new mail line/);
});

test('a blank/trailing line from the watcher never triggers an injection (gotcha a)', async () => {
  const injected = [];
  const spawnWatch = fakeSpawnWatch(555, ['real tick', '', '   ', '\n']);
  const plugin = createOursMonitorPlugin({ log: () => {}, killProcess: () => {}, spawnWatch });
  const hooks = await plugin({
    client: fakeClient(async (args) => { injected.push(args); return { response: { status: 204 } }; }),
    directory: '/proj',
  });
  await hooks.tool.ours_monitor_start.execute({ identity: 'Dev' }, { sessionID: 's1' });
  await flushMicrotasks();
  assert.equal(injected.length, 1, 'only the one real tick injects; blank lines are silently dropped');
});

test('ours_monitor_start called twice for the same session is a no-op the second time (one monitor per session)', async () => {
  const spawnWatch = fakeSpawnWatch(1, ['tick']);
  const plugin = createOursMonitorPlugin({ log: () => {}, killProcess: () => {}, spawnWatch });
  const hooks = await plugin({ client: fakeClient(async () => ({ response: { status: 204 } })), directory: '/proj' });

  const first = await hooks.tool.ours_monitor_start.execute({ identity: 'Dev' }, { sessionID: 's1' });
  const second = await hooks.tool.ours_monitor_start.execute({ identity: 'Alice' }, { sessionID: 's1' });
  assert.match(first.output, /Watching ours mail/);
  assert.match(second.output, /already running/);
  assert.match(second.output, /"Dev"/, 'reports the identity ALREADY being watched, not the rejected one');
});

test('ours_monitor_stop: no monitor running for this session reports that clearly, does not throw', async () => {
  const plugin = createOursMonitorPlugin({ log: () => {}, killProcess: () => {} });
  const hooks = await plugin({ client: fakeClient(async () => ({ response: { status: 204 } })), directory: '/proj' });
  const result = await hooks.tool.ours_monitor_stop.execute({}, { sessionID: 'nope' });
  assert.match(result.output, /no monitor is running/);
});

test('ours_monitor_stop: kills the captured pid IMMEDIATELY (no race — pid was known since start()) and removes the session from the registry', async () => {
  const killed = [];
  const registry = createMonitorRegistry();
  const spawnWatch = fakeHangingSpawnWatch(9999);
  const plugin = createOursMonitorPlugin({ registry, log: () => {}, killProcess: (pid) => killed.push(pid), spawnWatch });
  const hooks = await plugin({ client: fakeClient(async () => ({ response: { status: 204 } })), directory: '/proj' });

  // REQUIRED — stop() called with NO flushMicrotasks() at all, immediately after start()
  // returns. Bun.spawn's pid is available synchronously at spawn time, so there is no race here
  // to test — it's an invariant to prove holds.
  await hooks.tool.ours_monitor_start.execute({ identity: 'Dev' }, { sessionID: 's1' });
  assert.ok(registry.get('s1'), 'monitor is registered while running');

  const result = await hooks.tool.ours_monitor_stop.execute({}, { sessionID: 's1' });
  assert.match(result.output, /Stopped watching/);
  assert.deepEqual(killed, [9999], 'killed immediately, no deferred/async pid discovery needed');
  assert.equal(registry.get('s1'), undefined, 'stop() removes the session from the registry');
});

test('a fresh ours_monitor_start after stop works again (not permanently blocked by the old registry entry)', async () => {
  const spawnWatch = fakeSpawnWatch(1, ['tick']);
  const registry = createMonitorRegistry();
  const plugin = createOursMonitorPlugin({ registry, log: () => {}, killProcess: () => {}, spawnWatch });
  const hooks = await plugin({ client: fakeClient(async () => ({ response: { status: 204 } })), directory: '/proj' });

  await hooks.tool.ours_monitor_start.execute({ identity: 'Dev' }, { sessionID: 's1' });
  await hooks.tool.ours_monitor_stop.execute({}, { sessionID: 's1' });
  const restarted = await hooks.tool.ours_monitor_start.execute({ identity: 'Dev' }, { sessionID: 's1' });
  assert.match(restarted.output, /Watching ours mail/);
});

test('dispose(): stops and kills EVERY still-running monitor across all sessions', async () => {
  const killed = [];
  const registry = createMonitorRegistry();
  const pluginA = createOursMonitorPlugin({ registry, log: () => {}, killProcess: (pid) => killed.push(pid), spawnWatch: fakeHangingSpawnWatch(111) });
  const pluginB = createOursMonitorPlugin({ registry, log: () => {}, killProcess: (pid) => killed.push(pid), spawnWatch: fakeHangingSpawnWatch(222) });

  const hooksA = await pluginA({ client: fakeClient(async () => ({ response: { status: 204 } })), directory: '/a' });
  await hooksA.tool.ours_monitor_start.execute({ identity: 'Alice' }, { sessionID: 'sA' });
  const hooksB = await pluginB({ client: fakeClient(async () => ({ response: { status: 204 } })), directory: '/b' });
  await hooksB.tool.ours_monitor_start.execute({ identity: 'Bob' }, { sessionID: 'sB' });
  await flushMicrotasks();

  await hooksA.dispose();
  assert.equal(registry.get('sA'), undefined);
  assert.equal(registry.get('sB'), undefined);
  assert.equal(killed.length, 2, "dispose kills both sessions' processes, not just its own hooks instance's");
});

// ---------------------------------------------------------------------------
// Deterministic rate-limiter integration test: N rapid ticks -> injection stops + a loud
// (single) log line, never silently continuing.
// ---------------------------------------------------------------------------

test('REQUIRED — N rapid ticks trip the rate limiter: injections stop, exactly one loud DISARM log line, watcher keeps draining (no crash)', async () => {
  const MAX = 3;
  const injected = [];
  const logs = [];
  const N = 10; // well past MAX
  const spawnWatch = fakeSpawnWatch(1, Array.from({ length: N }, (_, i) => `tick-${i}`));
  const plugin = createOursMonitorPlugin({
    log: (line) => logs.push(line),
    killProcess: () => {},
    spawnWatch,
    // Deterministic, test-scale limiter — this is the seam a real ours_monitor_start call uses
    // too (createRateLimiter with defaults read from OURS_MONITOR_RATE_LIMIT_MAX/WINDOW_MS at
    // module load); injecting it directly here avoids depending on env vars that are only read
    // once, at import time, before any test gets to set them.
    rateLimiterFactory: () => createRateLimiter({ max: MAX, windowMs: 10 * 60 * 1000, now: Date.now }),
  });
  const hooks = await plugin({
    client: fakeClient(async (args) => { injected.push(args); return { response: { status: 204 } }; }),
    directory: '/proj',
  });

  await hooks.tool.ours_monitor_start.execute({ identity: 'Dev' }, { sessionID: 's1' });
  await flushMicrotasks(50);

  assert.equal(injected.length, MAX, `exactly ${MAX} ticks got through before the limiter tripped`);
  const disarmLines = logs.filter((l) => l.includes('RATE LIMIT TRIPPED'));
  assert.equal(disarmLines.length, 1, 'the trip is logged loudly EXACTLY ONCE, not once per suppressed tick');
  assert.match(disarmLines[0], /DISARMED/);
  // the remaining N-MAX ticks were silently suppressed, not crashed or retried
  assert.equal(injected.length, MAX, 'no further injections after the trip, even though more ticks arrived');
});

test('the SHIPPED default (no options) uses DEFAULT_RATE_LIMIT_MAX from the module', async () => {
  const injected = [];
  const N = DEFAULT_RATE_LIMIT_MAX + 5;
  const spawnWatch = fakeSpawnWatch(1, Array.from({ length: N }, (_, i) => `tick-${i}`));
  const plugin = createOursMonitorPlugin({
    log: () => {},
    killProcess: () => {},
    spawnWatch,
    // no rateLimiterFactory override -> uses the real createRateLimiter() with module defaults
  });
  const hooks = await plugin({
    client: fakeClient(async (args) => { injected.push(args); return { response: { status: 204 } }; }),
    directory: '/proj',
  });
  await hooks.tool.ours_monitor_start.execute({ identity: 'Dev' }, { sessionID: 's1' });
  await flushMicrotasks(50);
  assert.equal(injected.length, DEFAULT_RATE_LIMIT_MAX);
});
