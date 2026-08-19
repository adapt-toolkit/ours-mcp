// The ours connector: a stdio MCP server whose tools call the daemon's HTTP API.
// Replaces `runProxy`, which existed to keep one MCP session alive across a
// transport that cannot resume. There is no such session here.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { OursClient } from '@ours.network/sdk';

import { createOursMcpServer } from './mcp/server.js';
import { getBoundIdentity, rememberBinding } from './mcp/tool.js';
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
  /**
   * The identity this session should start bound to — `$OURS_BIND_IDENTITY`.
   *
   * For a SUPERVISOR that already knows which identity it launched a session
   * for. Without it the binding is the model's job: an agent has to call
   * `choose_identity` from its own instructions, which costs a round trip, can
   * get the name wrong, and has nothing to work from at all on a wake-up where
   * those instructions have fallen out of context.
   *
   * ⚠ THE BIND IS PLAIN AND STAYS PLAIN. See `seedBinding`.
   */
  bindIdentity?: string;
  /** Best-effort daemon start, when autoStart is on. */
  ensureDaemon?: () => Promise<void>;
}

const log = (s: string) => {
  // stdout is the JSON-RPC channel. NEVER report a stderr write failure via
  // stderr: once the harness is gone that feeds itself and burns a core.
  try { process.stderr.write(`ours: ${s}\n`); } catch { /* the reader is gone */ }
};

/**
 * Prove the daemon serves the typed API before accepting a frame.
 *
 * ⚠ PROBE THE ROUTE, NOT A VERSION. `/version` reports the HOST package's
 * number, so three numberings exist and a semver compare across them is not
 * well-defined. 404 = no typed surface; 401 is a DIFFERENT failure and must not
 * be laundered into "too old".
 *
 * Still needed after the hard switch: installing a package does not restart a
 * running daemon, so a new connector meets the old process every upgrade.
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

  // 400 is a catalogued OursError, i.e. it routed. 401 is reported as itself by
  // the caller's auth handling, not as age.
  if (res.status !== 404) {
    return { ok: true };
  }

  // Corroboration only — `compat` is a claim; the 404 is the finding.
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
 * Filtered daemon-side (`kinds`), keyed by identity NAME, and holds no session —
 * so nothing can be reaped and there is nothing to reconnect into.
 *
 * A first bind is picked up immediately. A REBIND while a poll is in flight is
 * picked up when that poll returns (~25s). Making it instant needs either a table
 * of which tools rebind — a second vocabulary — or a round trip per tool call.
 */
export class InboxWatcher {
  private stopped = false;
  private bound: string | null = null;
  private readonly ac = new AbortController();

  constructor(
    private readonly client: OursClient,
    private readonly server: ReturnType<typeof createOursMcpServer>,
  ) {}

  stop(): void { this.stopped = true; this.ac.abort(); }

  async run(): Promise<void> {
    while (!this.stopped) {
      if (this.bound === null) {
        // Read what runTool learned rather than asking the daemon again. This used
        // to resolve currentIdentity() itself, gated on a bump() that nothing ever
        // called — so the watch armed once before any bind, failed NOT_BOUND, and
        // then waited forever. Caught by test/resource-updated.test.mjs.
        const known = getBoundIdentity();
        if (known === null) { await sleep(250); continue; }
        this.bound = known;
        log(`[${this.bound}] watching for arrivals`);
      }
      const name = this.bound;
      try {
        for await (const ev of this.client.watchNotifications(name, { kinds: ['inbound'], signal: this.ac.signal })) {
          if (this.stopped) return;
          // Rendered here from the event's fields. The daemon used to render this
          // because it pushed the notification itself; the endpoint returns
          // content-free events, so formatting is the consumer's — the same split as
          // the kinds predicate, which is classification and stays daemon-side.
          const e = ev as unknown as { event?: string; from?: string; filename?: string };
          const summary = e.event === 'file_received'
            ? `new file ${e.filename ?? '?'} from ${e.from ?? '?'}`
            : `new message from ${e.from ?? '?'}`;
          pushInboxNotifications(this.server, inboxResourceUri(name), summary, (what, err) =>
            log(`[${name}] ${what} failed: ${String(err)}`));
          // Re-read after each batch: a rebind must not leave us announcing the
          // previous identity's inbox.
          if (getBoundIdentity() !== name) { this.bound = null; break; }
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
 * Bind `$OURS_BIND_IDENTITY` before the session serves its first tool call.
 *
 * ⚠ force: false, AND NOTHING HERE MAY EVER CHANGE THAT.
 *
 * This is the same call `choose_identity` makes, so it inherits that path's
 * refusal unchanged: a lease held by a LIVE session is declined, and only a
 * holder whose client pid is dead is reclaimed (and that reclaim is not a force
 * — ours-sdk src/api/identity.ts:397-403). A `force` here would turn an
 * environment variable into a remote-eviction primitive, usable by anything that
 * can set the environment of a spawned process. The tool's own description says
 * never to pass force without asking the user; a supervisor's seed has nobody to
 * ask, which is precisely why it must not be able to.
 *
 * FAIL-CLOSED, AND NEVER FATAL. Every refusal — no such identity, held by a live
 * session, a daemon that will not answer — leaves the session UNBOUND and
 * running. A role whose identity has not been created yet has to reach the step
 * in its own instructions that creates it; a connector that refused to start
 * would take the role down over a name.
 *
 * `rememberBinding` is what the rest of the connector reads: it arms the inbox
 * watch (InboxWatcher.run) and is the name `reassertBinding` re-asserts after a
 * daemon restart. Without it a seeded session would be bound daemon-side and
 * deaf locally until its first successful tool call resolved the name anyway.
 */
async function seedBinding(client: OursClient, name: string): Promise<void> {
  try {
    const bound = await client.chooseIdentity({ name, force: false });
    rememberBinding(bound.name);
    log(`[${bound.name}] bound from OURS_BIND_IDENTITY`);
  } catch (e) {
    // The reason is the useful half: "held by a live session" and "no such
    // identity" call for completely different next steps from the agent.
    log(
      `OURS_BIND_IDENTITY="${name}": not bound (${e instanceof Error ? e.message : String(e)}) — ` +
      'this session starts UNBOUND. Create the identity, or bind one with choose_identity.',
    );
  }
}

/**
 * Run the connector until stdin closes.
 *
 * The lease is NOT released on exit — see the note at the shutdown site. That was
 * my design and the test disproved it.
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
    // Both halves: a harness that sees an immediate exit reports "failed to start"
    // and swallows stderr, so the instructions are the copy that reaches the model.
    log(probe.reason);
    await refuseOverStdio(probe.reason, opts.version);
    return;
  }

  // Before the transport, not after: the probe above already proved the daemon
  // answers, so this is one localhost round trip, and doing it first means no
  // window exists in which the session is servable but not yet bound.
  const seed = (opts.bindIdentity ?? '').trim();
  if (seed) await seedBinding(client, seed);

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

    // ⚠ LISTEN ON process.stdin, NOT THE TRANSPORT: StdioServerTransport registers
    // only 'data' and 'error', so its onclose never fires and the process outlives
    // every session (~134-139 MB retained each). SIGHUP is not a safety net —
    // a harness gives us no tty.
    process.stdin.on('end', () => finish('stdin closed'));
    process.stdin.on('close', () => finish('stdin closed'));
    process.on('SIGINT', () => finish('SIGINT'));
    process.on('SIGTERM', () => finish('SIGTERM'));
    // SIGHUP is deliberately NOT a safety net: a harness spawns us with no tty,
    // so a hangup has no addressee. Nothing here may depend on it arriving.
  });

  watcher.stop();

  // ⚠ THE LEASE IS DELIBERATELY *NOT* RELEASED HERE.
  //
  // stdin closing means the HARNESS is gone, and this process cannot tell "the
  // session ended" from "the harness tore us down while idle and will respawn us".
  // Releasing loses the binding in the second case, and the agent gets "No identity
  // bound" on its next call — the exact bug the old session-restore record existed
  // to paper over (test/lease-survives-respawn.test.mjs measures it both ways).
  //
  // Nothing leaks: a lease whose client pid is dead is auto-reclaimed WITHOUT force
  // (ours-sdk src/api/identity.ts:397-403). So an abandoned lease is not a forced
  // eviction for the next session; it is reclaimed on contention.
  try { await transport.close(); } catch { /* already gone */ }
}

/**
 * Handshake, deliver the reason as the initialize `instructions`, serve nothing.
 * No tools are registered — that is the behaviour, not a stub: a second copy of
 * the tool list here would be the drift the single-vocabulary rule prevents.
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
