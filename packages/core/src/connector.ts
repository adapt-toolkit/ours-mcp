// The ours connector: a stdio MCP server whose tools call the daemon's HTTP API.
//
// ============================================================================
// WHAT THIS REPLACED, AND WHY THE REPLACEMENT IS SMALLER
// ============================================================================
// `runProxy` — an MCP-over-HTTP client that held one long-lived MCP session to
// the daemon's `/mcp`, absorbed the harness's ~15-minute re-`initialize`,
// replayed synthetic init + re-bind frames on a drop, tracked in-flight requests
// behind a watchdog, and escalated a dead notification SSE through a cooldown and
// a cap.
//
// Every one of those parts existed to keep ONE MCP SESSION ALIVE across a
// transport that cannot resume. There is no such session here. This process is
// the MCP server the harness talks to, and it reaches the daemon the same way the
// CLI and the SDK do: ordinary requests to the typed API. There is nothing to
// re-handshake, nothing to replay, and nothing to reconnect into.
//
// THE OWNER'S RULE, WHICH THIS FILE IS THE POINT OF: the daemon exposes THE API;
// the MCP server, the CLI and the SDK are all clients of it. Nothing here may
// reach past the API into the engine. If something is missing from the API it
// gets implemented IN the API — never worked around in this file.
//
// ----- WHY `/mcp` IS NOT MENTIONED ANYWHERE BELOW ---------------------------
// It is gone. `serve.ts` no longer injects an MCP integration into the SDK's
// `startDaemon`, so the daemon does not mount the route at all (the SDK's
// `startDaemon` 404s `/mcp` whenever nothing is injected). There is exactly one
// MCP server in the system and it is this one.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { OursClient } from '@ours.network/sdk';

import { createOursMcpServer } from './mcp/server.js';
import { inboxResourceUri } from './mcp/resources/inbox.js';
import { pushInboxNotifications } from './mcp/push.js';

export interface ConnectorOptions {
  /** Daemon base URL — the ORIGIN only, e.g. `http://127.0.0.1:3050`. No path. */
  url: string;
  /** Bearer token for the daemon's authenticated surface. Undefined in `open` mode. */
  apiToken?: string;
  /** The lease this session holds. Must be stable across a harness respawn. */
  leaseToken: string;
  /** The CLIENT's pid — the harness, not us. See the note at the call site. */
  clientPid: number;
  /** ours-mcp's version, for the MCP server identity and the startup line. */
  version: string;
  /** Best-effort daemon start, when autoStart is on. */
  ensureDaemon?: () => Promise<void>;
}

const log = (s: string) => {
  // stdout is the MCP JSON-RPC channel; diagnostics go to stderr, always.
  //
  // ⚠ AND A FAILED STDERR WRITE IS SWALLOWED, DELIBERATELY. Once the harness is
  // gone stderr is a dead pipe, and the previous connector's
  // `uncaughtException` handler logged the failure TO STDERR and stayed up —
  // which fed itself and burned a full core. Never report a stderr write failure
  // via stderr.
  try { process.stderr.write(`ours: ${s}\n`); } catch { /* the reader is gone */ }
};

/**
 * Prove the daemon serves the typed API before accepting a single frame.
 *
 * ⚠⚠ DETECT BY PROBING THE ROUTE, NOT BY COMPARING A VERSION. ⚠⚠
 *
 * `GET /version` reports the HOST package's version, not the SDK's. Three
 * numberings therefore exist — the old bundled daemon's own number, whatever host
 * started an SDK daemon, and the SDK's — and A SEMVER COMPARISON ACROSS THEM IS
 * NOT WELL-DEFINED. `compat` is better behaved but it is still a number the
 * daemon CLAIMS; the route is evidence of what it DOES. Anyone tempted to
 * "simplify" this into a version check should note that the simplification is
 * undetectable until someone runs a mismatched pair, which is the worst possible
 * time to find out.
 *
 * A 404 specifically means "no typed surface". A 401 is a DIFFERENT failure — an
 * auth problem — and must not be laundered into "too old", or an operator spends
 * the afternoon upgrading a daemon that was fine.
 *
 * WHY THIS SURVIVES THE HARD SWITCH. The daemon and the connector now ship
 * together, so there is no population running one against an old other. But
 * INSTALLING A PACKAGE DOES NOT RESTART A RUNNING DAEMON: for the window between
 * upgrade and restart, this new connector meets the OLD daemon process still in
 * memory on the same host, every single time. That window is now the probe's main
 * job, and the difference it makes is between "ours is broken" and "restart the
 * daemon".
 */
export async function probeTypedApi(
  url: string,
  apiToken: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiToken) headers['x-ours-api-token'] = apiToken;

  let res: Response;
  try {
    res = await fetchImpl(`${url}/api/v1/currentIdentity`, {
      method: 'POST',
      headers,
      body: '{}',
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    return { ok: false, reason: `the ours daemon at ${url} could not be reached: ${String(e)}` };
  }

  if (res.status !== 404) {
    // 200 answered, 400 is a catalogued OursError (NOT_BOUND is the expected one
    // on a fresh session) — both mean the route exists and routed. 401 falls here
    // too and is reported as itself by the caller's own auth handling, not as age.
    return { ok: true };
  }

  // Corroborate — but only in the message. `compat` is what the daemon SAYS; the
  // 404 above is what it DID, and the 404 is the finding.
  let found = 'unknown';
  try {
    const v = (await (await fetchImpl(`${url}/version`, { signal: AbortSignal.timeout(3000) })).json()) as {
      version?: unknown; compat?: unknown;
    };
    found = `version=${String(v?.version ?? '?')} compat=${String(v?.compat ?? '?')}`;
  } catch { /* the refusal stands without it */ }

  return {
    ok: false,
    reason:
      `the ours daemon at ${url} does not serve the typed API (POST /api/v1/currentIdentity answered 404). ` +
      `It reports ${found}. This ours-mcp talks to the daemon over that API and has no other route. ` +
      'If you have just upgraded, the OLD daemon is probably still running — restart it ' +
      '(`ours-mcp restart`, or restart the ours service). Otherwise upgrade the daemon.',
  };
}

/**
 * Follow the bound identity and announce arrivals on its inbox resource.
 *
 * Three properties, each of which is a decision:
 *
 * 1. **Filtered daemon-side** (`kinds: ['inbound']`). notifications.log carries
 *    ~20 event kinds, including `e2e_app_send` on this identity's OWN outbound
 *    messages. Filtering here would make this the third copy of one predicate —
 *    the drift the single-API rule exists to prevent. The daemon's cursor
 *    advances past filtered-out events, so a narrow watch costs no more than a
 *    wide one.
 * 2. **Keyed by identity NAME**, so it starts on bind and restarts on rebind.
 *    The old MCP session was keyed by session and needed no name; this is genuinely
 *    new state, and the loop below is all of it.
 * 3. **It holds no session.** Each poll is an independent bounded request, so
 *    there is nothing for the daemon's session reaper to reap and nothing to
 *    reconnect into forever.
 *
 * REBIND LATENCY, STATED PLAINLY: a bind is picked up immediately (`bump()` is
 * called when a tool call completes and we have no watch running). A REBIND from
 * one identity to another while a poll is in flight is picked up when that poll
 * returns, i.e. within the daemon's long-poll ceiling (~25s). Making that instant
 * would mean either a mapping table of which tools rebind — a second vocabulary,
 * which is exactly what must not be built — or a `currentIdentity` round trip on
 * every single tool call. Neither is worth ~25s of stale inbox pushes on an
 * operation an agent performs a handful of times per session.
 */
export class InboxWatcher {
  private bumped = true;
  private stopped = false;
  private bound: string | null = null;
  private readonly ac = new AbortController();

  constructor(
    private readonly client: OursClient,
    private readonly server: ReturnType<typeof createOursMcpServer>,
  ) {}

  /** Called when any tool call completes: a bind may have just happened. */
  bump(): void { this.bumped = true; }

  stop(): void { this.stopped = true; this.ac.abort(); }

  async run(): Promise<void> {
    while (!this.stopped) {
      if (this.bound === null) {
        if (!this.bumped) { await sleep(500); continue; }
        this.bumped = false;
        try {
          this.bound = (await this.client.currentIdentity()).name;
          log(`[${this.bound}] watching for arrivals`);
        } catch {
          // NOT_BOUND is the ordinary case on a fresh session, not an error. Wait
          // for the next completed tool call rather than polling the daemon.
          this.bound = null;
          continue;
        }
      }
      const name = this.bound;
      try {
        for await (const _ of this.client.watchNotifications(name, { kinds: ['inbound'], signal: this.ac.signal })) {
          if (this.stopped) return;
          pushInboxNotifications(this.server, inboxResourceUri(name), 'new mail', (what, err) =>
            log(`[${name}] ${what} failed: ${String(err)}`));
          // Re-resolve after each delivered batch: a rebind between arrivals must
          // not leave us announcing the previous identity's inbox.
          if (this.bumped) { this.bound = null; break; }
        }
      } catch (e) {
        if (this.stopped) return;
        // A watch failure is not fatal to the session — tool calls still work.
        // Drop the name so the next completed call re-resolves it, and say so:
        // a silently deaf agent is the failure mode this whole area exists to fix.
        log(`[${name}] arrival watch stopped (${String(e)}) — tool calls still work; will re-arm on the next call`);
        this.bound = null;
        await sleep(1000);
      }
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run the connector until stdin closes.
 *
 * ⚠ THE SHUTDOWN PATH IS LOAD-BEARING, NOT HYGIENE. This process HOLDS A LEASE
 * for its session. Force binding is staying (owner ruling), so a lease we fail to
 * release is a lease the NEXT session has to force past — which turns a
 * deliberately noisy handover into a confirmation prompt the user never earned.
 * Releasing on the way out is what keeps "force" meaning something.
 */
export async function runConnector(opts: ConnectorOptions): Promise<void> {
  if (opts.ensureDaemon) {
    await opts.ensureDaemon().catch((e) => log(`ensureDaemon: ${String(e)}`));
  }

  const client = new OursClient({
    url: opts.url,
    apiToken: opts.apiToken,
    leaseToken: opts.leaseToken,
    clientPid: opts.clientPid,
  });

  const probe = await probeTypedApi(opts.url, opts.apiToken);
  if (!probe.ok) {
    // BOTH halves, and they are one decision rather than two options. A harness
    // that sees an immediate exit usually reports "the MCP server failed to
    // start" and SWALLOWS STDERR, so a startup-only refusal can be invisible; the
    // tool-call answer below is the copy that reaches the model. Each covers the
    // other's failure mode, and together they cost almost nothing.
    log(probe.reason);
    await refuseOverStdio(probe.reason, opts.version);
    return;
  }

  const server = createOursMcpServer(client, opts.version);
  const watcher = new InboxWatcher(client, server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`MCP server v${opts.version} ready (transport=stdio, daemon=${opts.url})`);

  void watcher.run();

  await new Promise<void>((resolve) => {
    let done = false;
    const finish = (why: string) => {
      if (done) return;
      done = true;
      log(`shutting down (${why})`);
      resolve();
    };

    // ⚠ LISTEN ON `process.stdin`, NOT ON THE TRANSPORT.
    //
    // `StdioServerTransport` registers ONLY 'data' and 'error' on stdin, so its
    // `onclose` NEVER FIRES when the harness goes away. A shutdown hung off it
    // would never run, and the process would outlive every session — the measured
    // shape was ~134-139 MB retained per abandoned session (bounded per session,
    // not an unbounded per-operation leak). "The transport has an onclose, use
    // that" is the obvious wrong answer here.
    process.stdin.on('end', () => finish('stdin closed'));
    process.stdin.on('close', () => finish('stdin closed'));
    process.on('SIGINT', () => finish('SIGINT'));
    process.on('SIGTERM', () => finish('SIGTERM'));
    // SIGHUP is deliberately NOT a safety net: a harness spawns us with no tty,
    // so a hangup has no addressee. Nothing here may depend on it arriving.
  });

  watcher.stop();

  // Best-effort, BOUNDED, and attempted on every path. Bounded because we must
  // never hang an exit on a daemon that is already gone; attempted always because
  // of the lease note above.
  try {
    await Promise.race([
      client.releaseLease(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), 3000)),
    ]);
  } catch (e) {
    log(`lease release failed (continuing to exit): ${String(e)}`);
  }

  try { await transport.close(); } catch { /* already gone */ }
}

/**
 * Complete the MCP handshake for the sole purpose of telling the model why
 * nothing works, then serve nothing.
 *
 * A connector that exits immediately is reported by most harnesses as "failed to
 * start" with stderr discarded, so the refusal has to reach the channel the model
 * actually reads. It travels as the initialize result's `instructions`, which is
 * surfaced to the model at session start.
 *
 * NO TOOLS ARE REGISTERED, and that is the whole behaviour — not a stub. A call
 * to any ours tool therefore fails as an unknown tool rather than returning
 * prose. Registering all thirty names as refusers would put the reason on every
 * failed call, but it would also mean this file carrying a second copy of the
 * tool list, which is the drift the single-vocabulary rule exists to prevent —
 * and the instructions are read before the first call anyway.
 */
async function refuseOverStdio(reason: string, version: string): Promise<void> {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const server = new McpServer(
    { name: 'ours', version },
    { capabilities: {}, instructions: `ours is NOT AVAILABLE this session: ${reason}` },
  );
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // The daemon is the problem; do not amplify it into the log.
  server.server.onerror = () => { /* intentionally silent */ };
  await new Promise<void>((resolve) => {
    process.stdin.on('end', () => resolve());
    process.stdin.on('close', () => resolve());
    process.on('SIGINT', () => resolve());
    process.on('SIGTERM', () => resolve());
  });
  try { await transport.close(); } catch { /* already gone */ }
}
