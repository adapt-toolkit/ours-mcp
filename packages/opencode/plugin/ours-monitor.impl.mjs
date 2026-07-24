// Implementation module for the ours-monitor OpenCode plugin. The file OpenCode's `plugin`
// config key loads (ours-monitor.mjs) must export ONLY the plugin — OpenCode's loader rejects a
// module that exports non-function values alongside it. Every helper/constant (and every export
// the test suite needs) lives here in the impl module instead.
//
// The plugin watches for new ours.network mail and reacts autonomously without the OpenCode
// session blocking:
//   - `client.session.promptAsync(...)` injects a real, autonomous turn into an IDLE session
//     with no TUI attached and no user interaction (a 204 response confirms the turn was
//     accepted; the actual model turn follows).
//   - `Bun.spawn(['ours-mcp', 'watch', identity], {stdout: 'pipe'})` plus an explicit
//     incremental read of its stdout stream: `ours-mcp watch` is long-running and never exits,
//     so its output must be consumed as it arrives, line by line, rather than waited on to
//     complete. Bun.spawn also makes `proc.pid` available synchronously at spawn time, so
//     stop()/dispose() always have a pid to act on immediately.
//   - The `event` hook and `session.idle` in particular fire reliably, though this plugin
//     doesn't currently depend on them (documented for a future variant).
//
// Two tools: ours_monitor_start(identity), ours_monitor_stop(). One monitor per OpenCode
// session, keyed by sessionID. No identity auto-resolution — tool-arg only (a "current MCP
// binding" fallback was considered and rejected: one ours-mcp daemon holds many identities with
// no in-band signal for which one a given OpenCode session "means").
//
// SAFETY: every injected turn is a real, billed model turn, and a naive relay would let two
// monitored agents ping-pong each other indefinitely. A sliding-window rate limiter (below)
// caps auto-injections and DISARMS (stops injecting, stays running to keep draining/logging)
// rather than silently continuing once tripped — logged loudly so a human notices.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';

export const DEFAULT_RATE_LIMIT_MAX = Number(process.env.OURS_MONITOR_RATE_LIMIT_MAX || 5);
export const DEFAULT_RATE_LIMIT_WINDOW_MS = Number(process.env.OURS_MONITOR_RATE_LIMIT_WINDOW_MS || 10 * 60 * 1000);

// Pure description of the argv `ours-mcp watch <identity>` is spawned with. Bun.spawn takes an
// argv array directly — no shell involved — so `identity` is just a discrete argv element,
// never string-concatenated into anything a shell would re-interpret.
export function watchCommandArgv(identity) {
  return ['ours-mcp', 'watch', identity];
}

// Sliding-window rate limiter. `now` is injectable for deterministic tests. Once tripped,
// stays disarmed permanently for this instance (a fresh ours_monitor_start call gets a fresh
// limiter) — never silently re-arms on its own.
export function createRateLimiter({ max = DEFAULT_RATE_LIMIT_MAX, windowMs = DEFAULT_RATE_LIMIT_WINDOW_MS, now = Date.now } = {}) {
  const timestamps = [];
  let disarmed = false;
  return {
    isDisarmed: () => disarmed,
    // Call once per candidate injection. Returns whether this one is allowed, and whether
    // this specific call is the one that tripped the limit (so callers log the trip exactly
    // once, not on every subsequent suppressed tick).
    recordAndCheck() {
      if (disarmed) return { allowed: false, justDisarmed: false };
      const t = now();
      while (timestamps.length && t - timestamps[0] > windowMs) timestamps.shift();
      if (timestamps.length >= max) {
        disarmed = true;
        return { allowed: false, justDisarmed: true };
      }
      timestamps.push(t);
      return { allowed: true, justDisarmed: false };
    },
  };
}

// Classify one raw line from `ours-mcp watch`'s stdout: every non-blank line is a real new-mail
// tick. A blank/whitespace-only line (e.g. a trailing partial line when the stream ends) is
// never significant.
export function classifyLine(raw) {
  const line = (raw ?? '').trim();
  if (!line) return { kind: 'blank' };
  return { kind: 'tick', line };
}

export function buildInjectionText(identity, line) {
  return (
    `New ours.network mail arrived for identity "${identity}" (${line}). ` +
    'Use the ours skill: call get_messages, act on what arrived, and reply only if it warrants one.'
  );
}

export function defaultLogPath() {
  return process.env.OURS_MONITOR_LOG || join(homedir(), '.config', 'opencode', 'ours-monitor.log');
}

export function makeLogger(logPath) {
  mkdirSync(dirname(logPath), { recursive: true });
  return (line) => appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
}

// In-memory registry of active monitors, one per OpenCode session. Exported as a factory
// (not a module-level singleton) so tests can create an isolated instance per test.
export function createMonitorRegistry() {
  const bySession = new Map();
  return {
    get: (sessionID) => bySession.get(sessionID),
    set: (sessionID, state) => bySession.set(sessionID, state),
    delete: (sessionID) => bySession.delete(sessionID),
    entries: () => bySession.entries(),
  };
}

function defaultKillProcess(pid) {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Already exited — nothing to do.
  }
}

// Drain a Bun ReadableStream (ours-monitor's own stdout, or stderr — see below) into `onLine`,
// buffering across chunk boundaries. Shared by both stdout (real lines) and stderr (log-only)
// so the two readers are byte-for-byte the same shape.
async function drainLines(stream, onLine) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        onLine(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
      }
    }
    if (buf) onLine(buf);
  } finally {
    reader.releaseLock();
  }
}

// Default watcher: spawns `ours-mcp watch <identity>` via Bun.spawn and returns
// { pid, lines() } where lines() is an async generator of raw stdout lines (buffered across
// chunk boundaries). Overridable in tests so no real shell/process is ever touched there.
//
// stderr is piped but must be continuously read, not left alone: an unread pipe fills its OS
// buffer (~64KB), and once full, the child process blocks on its next write to that fd and never
// produces another stdout line either. `log` (passed in from the tool's own closure — see
// createOursMonitorPlugin below) drains it continuously so it can never back up; diagnostics
// from the watched process stay visible in the log instead of being discarded.
export function defaultSpawnWatch(identity, log = () => {}) {
  const proc = Bun.spawn(watchCommandArgv(identity), { stdout: 'pipe', stderr: 'pipe' });
  // Independent, concurrent drain of stderr — a totally separate stream/reader from stdout
  // below, so this never blocks or interleaves with the real tick-reading loop. Fire-and-forget
  // is correct here: this task's only job is to keep the pipe empty for the lifetime of the
  // process; nothing needs to await it.
  drainLines(proc.stderr, (line) => {
    const trimmed = line.trim();
    if (trimmed) log(`WATCHER STDERR identity=${identity} pid=${proc.pid}: ${trimmed}`);
  }).catch(() => {
    // stream closed/process gone — nothing to do, this is just drainage, not the main loop.
  });
  async function* lines() {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
          yield buf.slice(0, idx);
          buf = buf.slice(idx + 1);
        }
      }
      if (buf) yield buf;
    } finally {
      reader.releaseLock();
    }
  }
  return { pid: proc.pid, lines };
}

// Factory so tests can inject a fake registry/logger/rate-limiter/kill/spawn function and never
// touch a real filesystem, process, or shell. The returned value is an OpenCode `Plugin`
// (PluginInput => Promise<Hooks>) — createOursMonitorPlugin() with no args is the real,
// shipped plugin.
export function createOursMonitorPlugin({
  registry = createMonitorRegistry(),
  log = makeLogger(defaultLogPath()),
  rateLimiterFactory = createRateLimiter,
  killProcess = defaultKillProcess,
  spawnWatch = defaultSpawnWatch,
} = {}) {
  function stop(sessionID, reason) {
    const state = registry.get(sessionID);
    if (!state) {
      return { title: 'no monitor running', output: 'ours_monitor_stop: no monitor is running for this session.' };
    }
    state.stopped.value = true;
    // pid is known SYNCHRONOUSLY from spawnWatch() — there is no window where a monitor is
    // running but its pid isn't known yet.
    killProcess(state.pid);
    registry.delete(sessionID);
    log(`STOP session=${sessionID} identity=${state.identity} reason=${reason}`);
    return { title: 'monitor stopped', output: `Stopped watching ours mail for identity "${state.identity}".` };
  }

  return async ({ client, directory }) => ({
    dispose: async () => {
      for (const [sessionID] of registry.entries()) stop(sessionID, 'dispose');
    },
    tool: {
      ours_monitor_start: {
        description:
          'Start watching for new ours.network mail for IDENTITY and autonomously react (drain + reply) as it arrives, without the session blocking. Rate-limited: after the cap trips it disarms itself (stops auto-replying) and logs loudly rather than looping forever. Call ours_monitor_stop to end it.',
        args: {
          identity: z
            .string()
            .min(1)
            .describe('The bound ours.network identity name to watch, e.g. the one just bound with choose_identity.'),
        },
        async execute({ identity }, context) {
          const sessionID = context.sessionID;
          const existing = registry.get(sessionID);
          if (existing) {
            return {
              title: 'monitor already running',
              output: `A monitor is already running for this session (identity "${existing.identity}"). Call ours_monitor_stop first.`,
            };
          }

          const watcher = spawnWatch(identity, log);
          const state = { identity, rateLimiter: rateLimiterFactory(), stopped: { value: false }, pid: watcher.pid };
          registry.set(sessionID, state);
          log(`START session=${sessionID} identity=${identity} pid=${watcher.pid}`);

          // Fire-and-forget: NOT awaited, so execute() returns immediately and the watch
          // loop keeps running in the background for the life of the session/plugin.
          (async () => {
            try {
              for await (const raw of watcher.lines()) {
                if (state.stopped.value) break;
                const classified = classifyLine(raw);
                if (classified.kind === 'blank') continue;
                const check = state.rateLimiter.recordAndCheck();
                if (!check.allowed) {
                  if (check.justDisarmed) {
                    log(
                      `RATE LIMIT TRIPPED session=${sessionID} identity=${identity} — DISARMED, no further ` +
                        'auto-replies until ours_monitor_start is called again for this session',
                    );
                  }
                  continue; // keep draining the stream so it doesn't back up; just stop injecting
                }
                log(`TICK session=${sessionID} identity=${identity} line=${classified.line}`);
                const res = await client.session.promptAsync({
                  path: { id: sessionID },
                  query: { directory },
                  body: { parts: [{ type: 'text', text: buildInjectionText(identity, classified.line) }] },
                });
                log(`INJECTED session=${sessionID} identity=${identity} status=${res.response.status}`);
              }
            } catch (err) {
              log(`WATCHER ERROR session=${sessionID} identity=${identity} error=${err?.message ?? String(err)}`);
            } finally {
              log(`WATCHER ENDED session=${sessionID} identity=${identity}`);
              registry.delete(sessionID);
            }
          })();

          return {
            title: 'monitor started',
            output:
              `Watching ours mail for identity "${identity}" in the background ` +
              `(rate-limited to ${DEFAULT_RATE_LIMIT_MAX} auto-replies per ${Math.round(DEFAULT_RATE_LIMIT_WINDOW_MS / 60000)}min; ` +
              `a trip disarms rather than looping forever — check ${defaultLogPath()} if replies stop). ` +
              'Each tick is a real, billed model turn. Call ours_monitor_stop to end it.',
          };
        },
      },
      ours_monitor_stop: {
        description: 'Stop a monitor started by ours_monitor_start for this session.',
        args: {},
        async execute(_args, context) {
          return stop(context.sessionID, 'user-requested');
        },
      },
    },
  });
}
