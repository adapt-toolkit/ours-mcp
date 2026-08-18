//
// ours-mcp proxy — per-session stdio shim in front of the shared daemon.
//
// WHY THIS EXISTS
// Claude Code's streamable-http MCP client re-initializes its session on a fixed
// ~15-minute timer (undocumented, no disable switch). Each re-init mints a fresh
// mcp-session-id, and the daemon keys each identity binding to that session id —
// so every recycle orphans the binding and the agent sees "No identity bound".
// A *stdio* MCP server, by contrast, is spawned ONCE at session start and lives
// for the whole Claude Code session: no periodic re-handshake, no sid churn.
//
// So Claude Code talks stdio to THIS proxy (stable for the session), and the
// proxy holds ONE long-lived streamable-http session to the singleton daemon.
// Because the proxy is our own client (not Claude Code's 15-min recycler), the
// upstream session id is stable for the proxy's lifetime ⇒ the binding never
// churns. The daemon stays a shared singleton (it owns every identity's packet,
// the broker socket, file locks) — we cannot run one per session — which is
// exactly why a thin per-session shim, rather than "just run stdio", is needed.
//
// DESIGN
// A near-transparent transport-level JSON-RPC passthrough: frames from Claude are
// sent verbatim to the daemon and vice-versa. No per-method knowledge, so tools,
// resources, and server→client notifications (the daemon's logging messages) all
// forward transparently. The SDK opens the daemon's standalone notification SSE
// automatically once Claude's `notifications/initialized` flows through.
//
// The ONE exception is a repeat `initialize`: Claude's ~15-min re-handshake is
// answered LOCALLY from the cached first-init result instead of being forwarded.
// Forwarding it would mint a fresh daemon session id that the identity binding
// doesn't follow (the old session then ages out → "No identity bound"), which is
// exactly the churn this proxy exists to prevent. The first initialize still goes
// upstream to establish the binding-capable session.
//
// On the rare genuine upstream drop (daemon restart, network blip) the proxy
// reconnects and transparently REPLAYS the handshake + re-binds the identity the
// session was using — the daemon's no-force auto-reclaim (cb94eb1) takes the
// binding back from the now-dead prior session. Claude never sees an unbind.
//
// IDENTITY STATE IS PER-PROCESS, IN MEMORY ONLY, for the life of one connection.
// It is never written to disk keyed by folder/cwd: more than one session
// (identity) can run from the same directory, so a folder-keyed file would let
// sessions clobber each other.
//
// SESSION-KEYED RESTORE (A2A-1c). The in-memory rule above is necessary but not
// sufficient: an idle Claude Code wake-up TEARS DOWN the stdio connection and
// SPAWNS A FRESH PROXY PROCESS on re-invocation, so in-memory boundIdentity is
// lost and the agent — still believing it is bound — gets "No identity bound" on
// its next call. We therefore persist a TINY record {identity} keyed by
// CLAUDE_CODE_SESSION_ID (the Claude-session id, stable across wake-ups and
// inherited from this child's env), NOT by folder — so two concurrent sessions
// in the same directory have distinct keys and never clobber each other (the
// exact hazard the folder rule guards against). The record is written ONLY after
// we OBSERVE a successful bind (i.e. the user already confirmed the identity), and
// on a fresh boot we re-assert it ONLY when a stored record matches THIS env's
// CLAUDE_CODE_SESSION_ID. That is SELF-RECOVERY of an already-confirmed session
// (pre-authorized); it never performs a first-ever bind — a first bind in a
// pinned workspace stays gated by the SessionStart consent hook. No env id ⇒ no
// persistence (behaves exactly as the pure in-memory proxy did).
//
// stdout is the MCP JSON-RPC channel — all diagnostics go to stderr.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { formatVersionAdvisory } from './version-advisory';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, unlinkSync, chmodSync, createWriteStream, accessSync, constants as fsConstants } from 'node:fs';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { homedir } from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// Injected at build time by build.mjs (esbuild `define`) from package.json.
declare const __OURS_VERSION__: string;
const VERSION = typeof __OURS_VERSION__ !== 'undefined' ? __OURS_VERSION__ : '0.0.0-dev';

// Tools whose successful call binds an identity to this session. We watch for
// them so we can re-assert the binding after an upstream reconnect.
const BIND_TOOLS = new Set(['choose_identity', 'create_identity', 'create_root_identity']);

// save_file (issue #34) is the ONE tool the proxy does not forward transparently.
// The daemon runs as its owner and cannot write a cross-user recipient's chosen
// path; THIS process runs as the agent's OS user and can. So we intercept the
// call, fetch the file's raw bytes from the daemon's token-gated /files/<wire_id>
// stream (scoped daemon-side to the bound identity's own folder), write them to
// dest_path here, and synthesize the tool result. The bytes transit
// daemon→proxy→disk and never enter the JSON-RPC result / model context.
const SAVE_FILE_TOOL = 'save_file';

// get_files (issue #34) is forwarded transparently, but its RESULT is inspected on
// the way back. The daemon writes each received file into its OWNER's 0700 state
// dir and reports the path; whether that path is actually readable is a question
// only THIS process can answer, because it runs as the agent's OS user. So we
// probe each path with access(R_OK) and, for anything unreadable, rewrite the
// result into an explicit instruction: tell the user what arrived and ask where
// to put it, then call save_file({ wire_id, dest_path }). Without this the agent
// only discovers the cross-user split by trying to read the path and eating an
// EACCES it has to attribute correctly.
const GET_FILES_TOOL = 'get_files';

// Force the ask-for-a-destination path even when the daemon's copy IS readable.
// For agents that must place received files explicitly (sandboxes, shared-uid
// containers) rather than reach into the daemon's state dir — and the seam the
// test suite uses to exercise the unreadable branch as a single OS user.
const FILES_ALWAYS_PROMPT = ['1', 'true', 'yes', 'on'].includes(
  (process.env.OURS_FILES_ALWAYS_PROMPT ?? '').trim().toLowerCase(),
);

type ReceivedFileMeta = {
  wire_id: string;
  filename: string;
  path: string;
  mime: string;
  size: number;
  sha256: string;
  sender: string;
  kind?: 'file' | 'voice_message';
  transcription?: { status?: string };
};

// access(2) resolves against the REAL uid/gid and needs +x on every parent, so a
// daemon-owned 0700 state dir correctly reports unreadable here. No setuid in
// play, so real == effective and this is exactly what the agent would hit.
const canRead = (p: string): boolean => {
  try { accessSync(p, fsConstants.R_OK); return true; } catch { return false; }
};

const describeFile = (f: ReceivedFileMeta): string =>
  `  • ${f.filename} — ${f.mime || 'application/octet-stream'}, ${f.size} B, ` +
  `sha256 ${f.sha256} — from ${f.sender} — wire_id ${f.wire_id}`;

// Annotate a get_files result in place when some of its files are not readable by
// this OS user. Returns true if the result was annotated. No structuredContent
// (an older daemon) means no probe and no annotation — pure passthrough.
//
// The instruction is PREPENDED, never substituted for the daemon's own text. That
// text can carry payload the proxy cannot reconstruct — a voice message is
// delivered as a TRANSCRIPT, not as a path — so replacing it wholesale would drop
// real message content whenever an unreadable file shares a batch with one.
export function annotateGetFilesResult(result: unknown, readable: (p: string) => boolean): boolean {
  const r = result as
    | { content?: Array<{ type: string; text?: string }>; structuredContent?: { files?: unknown }; isError?: boolean }
    | undefined;
  if (!r || r.isError) return false;
  const raw = r.structuredContent?.files;
  if (!Array.isArray(raw)) return false;
  const files = raw.filter(
    (f): f is ReceivedFileMeta =>
      !!f && typeof f === 'object' && typeof (f as ReceivedFileMeta).path === 'string' && typeof (f as ReceivedFileMeta).wire_id === 'string',
  );
  if (files.length === 0) return false;

  // Voice delivery remains transcript-first for compatibility. Its structured
  // record still exposes the audio path/readability, but an unreadable daemon
  // copy must not turn a successfully delivered transcript/fallback into an
  // unsolicited destination prompt.
  const blocked = files.filter((f) => f.kind !== 'voice_message' && !readable(f.path));
  // Annotate the structured records either way so a structured consumer sees the
  // same truth the prose does.
  for (const f of files) (f as ReceivedFileMeta & { readable: boolean }).readable = readable(f.path);
  if (blocked.length === 0) return false;

  const lines: string[] = [
    `${blocked.length} of ${files.length} received file(s) are NOT readable by your OS user: the ours ` +
      `daemon runs as a different OS user and keeps its files dir private. Nothing was lost — the bytes ` +
      `are safely on disk. IGNORE the on-disk paths reported below for these files; you cannot open them.`,
    '',
    `TELL THE USER what arrived (details below) and ASK WHERE TO SAVE each file on this filesystem. ` +
      `Then call save_file({ wire_id, dest_path }) with the path they choose: the ours connector streams ` +
      `the bytes daemon→proxy→disk and writes them as YOUR OS user. The bytes never enter this conversation.`,
    '',
    'Awaiting a destination:',
    ...blocked.map(describeFile),
  ];
  r.content = [{ type: 'text', text: lines.join('\n') }, ...(r.content ?? [])];
  return true;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type AnyMsg = Record<string, unknown> & { id?: string | number; method?: string };

const isRequest = (m: AnyMsg): boolean =>
  typeof m?.method === 'string' && m.id !== undefined && m.id !== null;
const isResponse = (m: AnyMsg): boolean =>
  m && typeof m === 'object' && !('method' in m) && m.id !== undefined && m.id !== null;
const isError = (m: AnyMsg): boolean => {
  const r = (m as { result?: { isError?: boolean } }).result;
  return Boolean((m as { error?: unknown }).error) || Boolean(r && r.isError);
};

export interface ProxyOptions {
  /** Daemon MCP endpoint, e.g. http://127.0.0.1:3050/mcp */
  url: string;
  /** Best-effort: make sure the daemon is listening (called before each connect attempt). */
  ensureDaemon?: () => Promise<void>;
  /** Daemon state dir (per-host); the session-restore store lives under it. Defaults to OURS_STATE_DIR or ~/.ours. */
  stateDir?: string;
  /** Bearer token for the daemon HTTP surface (Part B). Undefined in `open` mode. */
  apiToken?: string;
}

// Session-restore records older than this are pruned on startup, and a record
// past its TTL is never self-recovered (a long-dead session's identity must not
// stay auto-grabbable forever). A record is only ever consulted by a NEW proxy
// whose env CLAUDE_CODE_SESSION_ID matches it (the same Claude session waking
// again), so stale records are otherwise harmless dead weight; this just bounds
// accumulation and the auto-grab window. Configurable via OURS_RESTORE_TTL_MS;
// generous default so a long-idle agent still recovers.
const RESTORE_TTL_MS =
  Number(process.env.OURS_RESTORE_TTL_MS) > 0
    ? Number(process.env.OURS_RESTORE_TTL_MS)
    : 7 * 24 * 60 * 60 * 1000;

// Opt-out (A2A-1c safety valve): any truthy value fully disables persistence and
// self-recovery — the proxy reverts to pure in-memory binding.
const AUTORESTORE_OPT_OUT = ['1', 'true', 'yes', 'on'].includes(
  (process.env.OURS_NO_AUTORESTORE ?? '').trim().toLowerCase(),
);

export async function runProxy(opts: ProxyOptions): Promise<void> {
  const url = new URL(opts.url);
  const log = (...a: unknown[]) => process.stderr.write(`[ours-proxy] ${a.join(' ')}\n`);

  // ---- per-process session state (in memory only — see header) -------------
  // Liveness pid = the CLIENT (Claude Code) process, not this connector (which
  // Claude tears down on idle). The launcher passes it via OURS_CLIENT_PID =
  // its own ppid; fall back to our ppid for direct-launch clients. Reject pids
  // <= 1 (init/launchd — macOS reparents orphans there; pidAlive(1) is always
  // true, which would make the lease unreclaimable). Last resort: our own pid.
  const validPid = (n: number) => Number.isInteger(n) && n > 1;
  const envClientPid = Number(process.env.OURS_CLIENT_PID);
  const clientPid = validPid(envClientPid) ? envClientPid
    : validPid(process.ppid) ? process.ppid
    : process.pid;
  // Stable holder token so a resumed session re-attaches its lease. Prefer the
  // client-provided session id; else derive from the (respawn-stable) client pid.
  const leaseToken = (process.env.CLAUDE_CODE_SESSION_ID ?? '').trim() || `client:${clientPid}`;
  let initializeMsg: AnyMsg | null = null; // Claude's `initialize` request (replayed on reconnect)
  let initializeResult: Record<string, unknown> | null = null; // daemon's first init result — replayed locally to absorb Claude's re-initializes
  let protocolVersion: string | undefined; // negotiated version, mirrored onto the upstream transport
  let boundIdentity: string | null = null; // identity this session bound; re-asserted on reconnect
  const pendingBind = new Map<string | number, string>(); // in-flight bind request id -> identity name
  const pendingGetFiles = new Set<string | number>(); // in-flight get_files request ids awaiting a readability probe
  let versionAdvisory: string | null = null; // non-blocking version-skew notice set by runCompatHandshake

  // ---- session-keyed restore (A2A-1c) ---------------------------------------
  // A cold Claude wake-up spawns a fresh proxy, losing in-memory boundIdentity.
  // We persist {identity} keyed by CLAUDE_CODE_SESSION_ID so the SAME Claude
  // session re-binds itself transparently on the next boot. Keyed by session id
  // (not folder/cwd) so concurrent same-dir sessions never collide. Self-recovery
  // only: written after an OBSERVED successful bind, re-asserted only on an exact
  // session-id match — never a first-ever bind (see header).
  const claudeSessionId = AUTORESTORE_OPT_OUT ? null : (process.env.CLAUDE_CODE_SESSION_ID ?? '').trim() || null;
  const restoreStateDir = opts.stateDir ?? process.env.OURS_STATE_DIR ?? join(homedir(), '.ours');
  const restoreDir = join(restoreStateDir, 'session-restore');
  // A session id is used as a filename; keep it to a safe charset so a hostile or
  // odd value can't escape the directory. Claude's ids are uuids, so this is a
  // belt-and-suspenders guard, not an expected path.
  const safeSessionId = claudeSessionId && /^[A-Za-z0-9._-]{1,200}$/.test(claudeSessionId) ? claudeSessionId : null;
  const restoreFile = safeSessionId ? join(restoreDir, `${safeSessionId}.json`) : null;
  let restoreAsserted = false; // we re-assert a disk-seeded identity at most once per process
  let restoreRid: string | null = null; // id of the in-flight self-recovery bind, so a refusal can clear boundIdentity

  // Persist the just-confirmed identity for this Claude session. Name only — no
  // secret material — consistent with the content-free persistence philosophy
  // (mirrors bindings.json). Mode 0600 / dir 0700 (A2A-9: don't widen at-rest).
  function persistRestore(name: string): void {
    if (!restoreFile) return;
    try {
      mkdirSync(restoreDir, { recursive: true, mode: 0o700 });
      writeFileSync(
        restoreFile,
        JSON.stringify({ claudeSessionId, identity: name, boundAt: new Date().toISOString() }),
        { mode: 0o600 },
      );
      // Create-time mode is umask-masked and ignored if the path pre-exists, so
      // enforce the perms explicitly — belt-and-suspenders against a pre-existing
      // wider dir/file (this record sits in the security model).
      chmodSync(restoreDir, 0o700);
      chmodSync(restoreFile, 0o600);
    } catch (e) {
      log('restore persist failed (non-fatal):', String(e));
    }
  }

  // Load this session's stored identity, if any, on a fresh boot. Returns the
  // identity name to self-recover, or null (no record / unreadable / no env id).
  function loadRestore(): string | null {
    if (!restoreFile) return null;
    try {
      if (Date.now() - statSync(restoreFile).mtimeMs > RESTORE_TTL_MS) return null; // expired — never auto-grab
      const rec = JSON.parse(readFileSync(restoreFile, 'utf8')) as { identity?: unknown };
      const name = typeof rec.identity === 'string' ? rec.identity.trim() : '';
      return name || null;
    } catch {
      return null; // ENOENT on first ever boot is the common, expected case
    }
  }

  // Best-effort GC: drop restore records older than the TTL. Stale records are
  // never auto-applied (they need a live session-id match) but shouldn't pile up.
  function pruneRestores(): void {
    try {
      const now = Date.now();
      for (const f of readdirSync(restoreDir)) {
        if (!f.endsWith('.json')) continue;
        const p = join(restoreDir, f);
        try { if (now - statSync(p).mtimeMs > RESTORE_TTL_MS) { unlinkSync(p); log('session-restore: pruned expired record', f); } } catch { /* ignore */ }
      }
    } catch { /* dir absent on first run — nothing to prune */ }
  }

  // ---- in-flight request tracking / fail-back (DEFECT A) --------------------
  // A request that POSTed successfully but whose response stream then broke is
  // never retried by the SDK (a POST stream has isReconnectable=false and, with no
  // eventStore, no priming event, so needsReconnect=false) and never surfaces:
  // transport.onerror fires but carries NO request id, so nothing here can
  // correlate it. The caller waits forever.
  //
  // WHAT THIS IS AND IS NOT. This does NOT prevent the hang and makes no claim
  // about what causes it — as of 2026-07-29 the cause is genuinely unknown (nine
  // captured SSE disconnects produced exactly one hang, which killed the
  // reconnect-race theory). It converts an unbounded silent wait into a bounded,
  // visible failure. That is correct under EVERY candidate cause, which is
  // precisely why it is the safe thing to build while the cause is unknown — and
  // the waited_ms it reports is evidence for diagnosing the real one.
  //
  // SCOPE, STATED HONESTLY: this protects callers on the PROXY path only. Clients
  // that reach the daemon through the MCP plugin get nothing from it. It is not a
  // fix for any particular third-party deployment's hang.
  //
  // WE NEVER REPLAY THE REQUEST. Replay is not safe for arbitrary tools —
  // get_messages MARKS MAIL READ and delivers exactly once, so a blind retry could
  // consume messages that reach nobody, turning a hang into silent data loss. If
  // replay is ever wanted it starts from an explicit allowlist of proven-idempotent
  // tools, never a denylist. A clean error lets the caller decide with knowledge we
  // do not have here.
  //
  // Default 120s is deliberately ABOVE the MCP SDK's own 60s client timeout
  // (DEFAULT_REQUEST_TIMEOUT_MSEC) so we never pre-empt a decision the caller would
  // make for itself; an SDK-based client fails on its own first. The beneficiary is
  // a caller with no timeout of its own, plus our stderr visibility. Measured tool
  // round-trips on a live daemon are 3–43ms, so the headroom is three orders of
  // magnitude — this cannot fire on a healthy call.
  const REQUEST_TIMEOUT_MS = (() => {
    const raw = (process.env.OURS_REQUEST_TIMEOUT_MS ?? '').trim();
    if (raw === '') return 120_000;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 120_000; // 0 disables the watchdog
  })();

  type InFlight = {
    method: string;
    sentAt: number;
    deadline: number;
    transport: StreamableHTTPClientTransport | null; // which upstream actually carried it
    progressToken?: string | number;
  };
  const inFlight = new Map<string | number, InFlight>();
  const progressTokens = new Map<string | number, string | number>(); // progressToken -> request id

  // Fail a request back to Claude as a real JSON-RPC error. MCP's own codes:
  // -32001 RequestTimeout, -32000 ConnectionClosed.
  function failRequest(id: string | number, code: number, reason: string): void {
    const e = inFlight.get(id);
    if (!e) return;
    inFlight.delete(id);
    if (e.progressToken !== undefined) progressTokens.delete(e.progressToken);
    const waitedMs = Date.now() - e.sentAt;
    log(`FAILING BACK request id=${String(id)} method=${e.method} waited_ms=${waitedMs} reason=${reason}`);
    down
      .send({
        jsonrpc: '2.0',
        id,
        error: {
          code,
          message: `ours proxy: no response from the ours daemon for "${e.method}" after ${waitedMs}ms (${reason}). The request was NOT retried — retry it yourself if it is safe to repeat.`,
          data: { reason, method: e.method, waitedMs },
        },
      } as unknown as JSONRPCMessage)
      .catch((err) => log('fail-back send failed:', String(err)));
  }

  // PRIMARY trigger: the watchdog. Cause-agnostic — it does not care why the answer
  // never came. A single sweeper rather than a timer per request.
  if (REQUEST_TIMEOUT_MS > 0) {
    const sweeper = setInterval(() => {
      const now = Date.now();
      for (const [id, e] of [...inFlight]) if (e.deadline <= now) failRequest(id, -32001, 'watchdog timeout');
    }, 1000);
    sweeper.unref?.();
  }

  // ---- notification-stream escalation (DEFECT B) ----------------------------
  // Anti-churn: A2A-8 deliberately made transient SSE errors log-only so a blip
  // could not churn the session and lose the binding. That intent is preserved —
  // we escalate ONLY on the SDK's terminal "retries exhausted" message, never on a
  // transient one, and a cooldown stops escalations chaining into a hot loop.
  const ESCALATION_COOLDOWN_MS = 60_000;
  const MAX_ESCALATIONS = 3;
  let lastEscalation = 0;
  let escalations = 0;

  // Tell the MODEL, not just stderr. A deaf agent with a quiet log is the failure
  // mode we are fixing; loud has to mean loud in the channel someone is reading.
  function notifyDownstream(level: 'error' | 'warning', text: string): void {
    down
      .send({
        jsonrpc: '2.0',
        method: 'notifications/message',
        params: { level, logger: 'ours-proxy', data: text },
      } as unknown as JSONRPCMessage)
      .catch((e) => log('downstream notify failed:', String(e)));
  }

  // ---- upstream lifecycle ---------------------------------------------------
  let up: StreamableHTTPClientTransport | null = null;
  /** Read `up` without TS narrowing it to null (it is assigned inside openUpstream). */
  const currentUp = (): StreamableHTTPClientTransport | null => up;
  let upReady = false;
  let shuttingDown = false;
  let reconnecting = false;
  const pendingToUp: JSONRPCMessage[] = []; // downstream frames buffered while upstream is down

  // Synthetic frames we inject on reconnect (replayed init + re-bind). Their
  // responses must be swallowed, never forwarded to Claude.
  const SYN_INIT = '__ours_proxy_init__';
  let rebindSeq = 0;
  const swallowIds = new Set<string | number>();
  const synInitIds = new Set<string | number>(); // synthetic init ids awaiting a protocolVersion

  const down = new StdioServerTransport();

  // ---- downstream (Claude) → upstream (daemon) ------------------------------
  down.onmessage = (raw) => {
    const toForward: AnyMsg[] = [];
    let sawInitialized = false;
    for (const m of asList(raw)) {
      const msg = m as AnyMsg;
      if (msg.method === 'notifications/initialized') sawInitialized = true;
      if (isRequest(msg)) {
        if (msg.method === 'initialize') {
          initializeMsg = msg;
          // Claude Code re-initializes on a ~15-min timer. The FIRST initialize must
          // reach the daemon to establish the binding-capable session; every REPEAT
          // initialize must NOT — forwarding it would mint a fresh daemon sid that the
          // lease's routing sid pointer wouldn't follow until the next tool call,
          // causing a sid churn window where the identity binding is temporarily lost.
          // Answer repeats locally from the cached first-init result so the single
          // upstream session (and its binding) is never churned.
          if (initializeResult) {
            log('absorbed re-initialize locally — upstream session kept stable');
            down
              .send({ jsonrpc: '2.0', id: msg.id, result: initializeResult } as unknown as JSONRPCMessage)
              .catch((e) => log('local initialize reply failed:', String(e)));
            continue; // do NOT forward upstream
          }
        }
        if (msg.method === 'tools/call') {
          const params = msg.params as { name?: string; arguments?: { name?: string } } | undefined;
          if (params && BIND_TOOLS.has(params.name ?? '') && typeof params.arguments?.name === 'string') {
            pendingBind.set(msg.id as string | number, params.arguments.name);
          }
          // Forwarded normally, but remember the id so the RESULT can be probed for
          // readability on the way back (see GET_FILES_TOOL / annotateGetFilesResult).
          if (params?.name === GET_FILES_TOOL) pendingGetFiles.add(msg.id as string | number);
          // Fulfil save_file locally (see SAVE_FILE_TOOL) — do NOT forward upstream.
          if (params?.name === SAVE_FILE_TOOL) {
            const args = (msg.params as { arguments?: Record<string, unknown> } | undefined)?.arguments ?? {};
            void handleSaveFile(msg.id as string | number, args);
            continue; // handled locally; the daemon never sees this tools/call
          }
        }
        // Track it for the fail-back. Only frames that actually go upstream are
        // registered — a locally-absorbed re-initialize `continue`s above and never
        // reaches here, and our synthetic frames go through forwardUp directly
        // rather than through this handler, so neither is ever tracked.
        if (REQUEST_TIMEOUT_MS > 0) {
          const id = msg.id as string | number;
          const meta = (msg.params as { _meta?: { progressToken?: string | number } } | undefined)?._meta;
          const now = Date.now();
          inFlight.set(id, {
            method: typeof msg.method === 'string' ? msg.method : 'unknown',
            sentAt: now,
            deadline: now + REQUEST_TIMEOUT_MS,
            transport: null,
            progressToken: meta?.progressToken,
          });
          if (meta?.progressToken !== undefined) progressTokens.set(meta.progressToken, id);
        }
      }
      toForward.push(msg);
    }
    if (toForward.length) {
      const out = Array.isArray(raw)
        ? (toForward as unknown as JSONRPCMessage)
        : (toForward[0] as unknown as JSONRPCMessage);
      forwardUp(out);
    }
    // After Claude's first `initialized` flows upstream (so the daemon session
    // exists and accepts tool calls), self-recover a disk-seeded identity. This
    // covers the INITIAL boot — reconnect() handles later genuine drops. Once-per
    // process; only fires when boundIdentity was seeded from a session-restore
    // record (a true first-ever boot has none → first bind stays hook-gated).
    if (sawInitialized) assertRestoreBinding();
  };
  down.onclose = () => void shutdown(0);
  down.onerror = (e) => log('downstream error:', String(e));

  // THE EXIT PATH. `down.onclose` above looks like it covers "the client went
  // away". It does not, and cannot: StdioServerTransport.start() registers only
  // 'data' and 'error' on stdin — no 'end', no 'close' — and it invokes
  // `onclose?.()` ONLY from its own close(), which we call solely inside
  // shutdown(). So onclose can fire only after the very thing it was meant to
  // trigger has already happened. Every real termination a client performs
  // (clean exit, being killed, its stdio closing) reaches this process as stdin
  // EOF and NOTHING ELSE, and until now nothing here listened for it: the proxy
  // outlived every session it served, holding ~134 MB and — once the daemon
  // reaped its session for a dead client pid — spinning a core forever.
  //
  // cli.ts's own comment on the `proxy` case says "Runs until stdin closes".
  // This is what makes that true. We listen on stdin ourselves rather than
  // teaching the SDK transport to, because the transport is not ours and the
  // guarantee is: when the thing that spawned us stops talking, we stop.
  //
  // SIGHUP is deliberately not the answer here. It is delivered only to the
  // foreground process group of a controlling terminal, and a harness that
  // spawns an MCP stdio server over pipes has no tty at all — so a hangup has
  // no addressee and the escape hatch fails closed exactly where it is needed.
  const clientGone = (why: string): void => {
    log(`stdin ${why} — the client is gone; shutting down`);
    void shutdown(0);
  };
  // 'end' is the EOF itself; 'close' covers a destroyed handle that never got to
  // emit 'end'. shutdown() is idempotent, so hearing both is harmless.
  process.stdin.once('end', () => clientGone('reached EOF'));
  process.stdin.once('close', () => clientGone('closed'));

  // Inject a synthetic, swallowed choose_identity to re-bind the disk-seeded
  // identity on a fresh boot. PLAIN bind (never force): if a genuinely live other
  // session holds it, the daemon refuses and we stay unbound (fail-closed — the
  // proxy must never auto-evict). Routed through forwardUp so it buffers until
  // upstream is ready. The response is swallowed (Claude never sees it).
  function assertRestoreBinding(): void {
    if (restoreAsserted || !boundIdentity) return;
    restoreAsserted = true;
    const rid = `__ours_proxy_restore_${++rebindSeq}__`;
    swallowIds.add(rid);
    restoreRid = rid;
    log('session-restore: self-recovering bound identity', `"${boundIdentity}"`);
    forwardUp({
      jsonrpc: '2.0',
      id: rid,
      method: 'tools/call',
      params: { name: 'choose_identity', arguments: { name: boundIdentity } },
    } as unknown as JSONRPCMessage);
  }

  // Record which upstream transport actually carried each tracked request. Set at
  // SEND time, not registration time: a frame buffered while upstream is down goes
  // out on the NEXT transport, and must not be swept when the old one dies.
  function markSentOn(raw: JSONRPCMessage, t: StreamableHTTPClientTransport): void {
    if (REQUEST_TIMEOUT_MS <= 0) return;
    for (const m of asList(raw)) {
      const id = (m as AnyMsg).id as string | number | undefined;
      if (id === undefined) continue;
      const e = inFlight.get(id);
      if (e) e.transport = t;
    }
  }

  // Fulfil a save_file tools/call locally: pull the file's raw bytes from the
  // daemon's token-gated stream (scoped daemon-side to the bound identity's own
  // folder) and write them to dest_path as THIS process's OS user (the agent's).
  // The bytes go daemon→proxy→disk and never appear in the JSON-RPC result. On
  // any failure we reply with a clear, actionable error so the agent can fall
  // back to the get_files path — we never hard-break.
  async function handleSaveFile(id: string | number, args: Record<string, unknown>): Promise<void> {
    const wireId = String(args.wire_id ?? '').trim();
    const destPath = String(args.dest_path ?? '').trim();
    const reply = (text: string, isError = false) =>
      down
        .send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError } } as unknown as JSONRPCMessage)
        .catch((e) => log('save_file reply failed:', String(e)));
    if (!wireId || !destPath) { await reply('save_file: both `wire_id` and `dest_path` are required.', true); return; }
    if (!/^[A-Za-z0-9]+$/.test(wireId)) { await reply('save_file: invalid wire_id.', true); return; }
    try {
      const fetchUrl = new URL(url.href);
      fetchUrl.pathname = `/files/${encodeURIComponent(wireId)}`;
      fetchUrl.search = '';
      const headers: Record<string, string> = { 'x-ours-lease-token': leaseToken };
      if (opts.apiToken) headers['x-ours-api-token'] = opts.apiToken;
      const resp = await fetch(fetchUrl, { headers });
      if (resp.status === 401 || resp.status === 403) { await reply('save_file: ours daemon authentication failed; the monitor may be disarmed.', true); return; }
      if (resp.status === 404) { await reply(`save_file: no file with wire_id ${wireId} is available to the bound identity. Run get_files first; it may already be saved, or it belongs to another identity.`, true); return; }
      if (!resp.ok || !resp.body) { await reply(`save_file: ours daemon returned HTTP ${resp.status}. Your ours daemon may be too old to support save_file — update it, or use get_files and copy the returned path yourself.`, true); return; }
      const abs = resolvePath(destPath);
      mkdirSync(dirname(abs), { recursive: true });
      await pipeline(Readable.fromWeb(resp.body as unknown as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(abs));
      const size = statSync(abs).size;
      await reply(`Saved file (wire_id ${wireId}) to ${abs} (${size} bytes). The bytes were streamed daemon→proxy→disk and never entered this result.`);
    } catch (e) {
      await reply(`save_file failed: ${String(e)}`, true);
    }
  }

  function forwardUp(raw: JSONRPCMessage): void {
    if (upReady && up) {
      const sentOn = up;
      markSentOn(raw, sentOn);
      up.send(raw).catch((e) => {
        // A daemon restart surfaces HERE (failed POST, "No valid session ID"), NOT
        // as transport.onclose. Drop the dead upstream so we reconnect.
        //
        // *** DO NOT RE-QUEUE REQUESTS HERE. *** This used to push `raw` onto
        // pendingToUp unconditionally, on the premise that a rejected send means
        // "the frame never reached the daemon". THAT PREMISE IS FALSE: send() also
        // rejects when the POST was ACCEPTED and the daemon ran the tool, but the
        // response stream then broke. reconnect() replays pendingToUp, so that path
        // could silently execute a tool call TWICE — and for get_messages, which
        // marks mail read and delivers exactly once, the second run consumes
        // messages that reach nobody. A hang turned into silent data loss.
        // (Caught by test/proxy-request-failback.test.mjs, which observed the same
        // request arriving at the daemon twice.)
        //
        // So: notifications are fire-and-forget and safe to re-queue; requests are
        // NOT, and are failed back to the caller instead. The caller knows whether
        // repeating is safe; we do not.
        log('upstream send failed:', String(e));
        const parts = asList(raw);
        const replayable = parts.filter((m) => !isRequest(m as AnyMsg));
        if (replayable.length) {
          pendingToUp.push(
            (Array.isArray(raw) ? replayable : replayable[0]) as unknown as JSONRPCMessage,
          );
        }
        for (const m of parts) {
          const msg = m as AnyMsg;
          if (isRequest(msg) && inFlight.has(msg.id as string | number)) {
            failRequest(msg.id as string | number, -32000, 'upstream send failed');
          }
        }
        dropUpstream(sentOn, 'send failed');
      });
    } else {
      pendingToUp.push(raw);
    }
  }

  // Tear down current upstream + reconnect. Single-flight (reconnect() guards on
  // `reconnecting`); ignores reports from an already-replaced transport so a late
  // onclose/onerror can't clobber a fresh reconnect.
  function dropUpstream(from: StreamableHTTPClientTransport | null, reason: string): void {
    if (shuttingDown) return;
    if (reconnecting) return;                 // reconnect loop owns recovery
    if (up !== null && from !== up) return;   // stale transport
    log(`upstream dropped (${reason}) — reconnecting`);
    upReady = false; const old = up; up = null;
    try { void old?.close?.(); } catch {}
    // SECONDARY trigger: a request that was carried by the transport we just tore
    // down provably cannot be answered — its response stream died with it. Fail
    // those now instead of making the caller wait out the watchdog. This is an
    // OPTIMISATION on latency-to-error only, and is deliberately not relied upon:
    // it is cause-specific, and the watchdog above is what actually guarantees the
    // caller stops waiting.
    if (old) {
      for (const [id, e] of [...inFlight]) {
        if (e.transport === old) failRequest(id, -32000, `upstream dropped (${reason})`);
      }
    }
    void reconnect();
  }
  // ---- upstream (daemon) → downstream (Claude) ------------------------------
  function attachUp(t: StreamableHTTPClientTransport): void {
    t.onmessage = (raw) => {
      const forward: AnyMsg[] = [];
      for (const m of asList(raw)) {
        const msg = m as AnyMsg;
        // A progress notification means the request IS alive and being worked on.
        // The SDK's own resetTimeoutOnProgress defaults to FALSE, so without this
        // the watchdog would kill long calls the caller is happily waiting on —
        // a correctness requirement, not a nicety.
        if (msg.method === 'notifications/progress') {
          const tok = (msg.params as { progressToken?: string | number } | undefined)?.progressToken;
          if (tok !== undefined) {
            const rid = progressTokens.get(tok);
            const e = rid !== undefined ? inFlight.get(rid) : undefined;
            if (e) e.deadline = Date.now() + REQUEST_TIMEOUT_MS;
          }
        }
        if (isResponse(msg)) {
          const id = msg.id as string | number;
          // Answered — stop watching it.
          const tracked = inFlight.get(id);
          if (tracked) {
            inFlight.delete(id);
            if (tracked.progressToken !== undefined) progressTokens.delete(tracked.progressToken);
          }
          // Capture the negotiated protocol version from any initialize result
          // (Claude's first one, and replayed ones), then mirror it upstream so
          // subsequent requests carry the mcp-protocol-version header.
          const ver = (msg as { result?: { protocolVersion?: string } }).result?.protocolVersion;
          if (ver && (synInitIds.has(id) || isInitId(id))) {
            protocolVersion = ver;
            try { up?.setProtocolVersion?.(ver); } catch { /* older SDK */ }
            // Cache the genuine first-init result (Claude's real initialize, not our
            // swallowed synthetic reconnect init) so down.onmessage can answer repeat
            // initializes locally without churning the upstream session.
            if (initializeResult == null && isInitId(id) && !swallowIds.has(id)) {
              const result = (msg as { result?: Record<string, unknown> }).result ?? null;
              if (result && versionAdvisory) {
                // Intentionally mutates the live msg.result so the advisory rides
                // this first initialize response to the model.
                result.instructions = `${result.instructions ? result.instructions + '\n\n' : ''}${versionAdvisory}`;
              }
              initializeResult = result;
            }
            synInitIds.delete(id);
          }
          if (swallowIds.has(id)) {
            swallowIds.delete(id);
            // A refused self-recovery bind (identity genuinely live in another
            // session) must clear boundIdentity so the proxy matches daemon truth
            // immediately — fail-closed, no auto-evict.
            if (id === restoreRid) {
              restoreRid = null;
              if (isError(msg)) { boundIdentity = null; log('session-restore: re-bind refused (identity live elsewhere) — staying unbound'); }
            }
            continue;
          } // our synthetic frame
          if (pendingGetFiles.has(id)) {
            pendingGetFiles.delete(id);
            const rewrote = annotateGetFilesResult(
              (msg as { result?: unknown }).result,
              FILES_ALWAYS_PROMPT ? () => false : canRead,
            );
            if (rewrote) log('get_files: daemon copy unreadable by this OS user — asked the agent for a destination');
          }
          if (pendingBind.has(id)) {
            const name = pendingBind.get(id)!;
            pendingBind.delete(id);
            if (!isError(msg)) {
              boundIdentity = name;
              log('bound identity tracked:', name);
              // Persist for self-recovery after a cold wake-up. A later switch to a
              // different identity overwrites this; the daemon exposes no unbind tool,
              // so re-bind is the only mutation and overwrite is the only edge.
              persistRestore(name);
            }
          }
        }
        forward.push(msg);
      }
      if (forward.length) {
        const out = Array.isArray(raw) ? (forward as unknown as JSONRPCMessage) : (forward[0] as unknown as JSONRPCMessage);
        down.send(out).catch((e) => log('downstream send failed:', String(e)));
      }
    };
    // A2A-8: do NOT full-reconnect on a transient SSE error. The ~5-min
    // "terminated" is undici's client-side bodyTimeout (300000ms inter-chunk)
    // aborting the idle standalone SSE GET — NOT the daemon dying. The SDK
    // reconnects that stream in place on the SAME session (a direct client is
    // unaffected), so tearing the session down here would needlessly churn and
    // lose the binding. Genuine session death still recovers: a daemon restart
    // surfaces on the next POST via the failed-send path in forwardUp (re-queue +
    // dropUpstream), and a full transport close still hits onclose below.
    //
    // …but an EXHAUSTED notification stream is NOT transient, and must not stay a
    // silent permanent death (DEFECT B). The SDK's terminal message is a stable
    // string; on it we escalate to a real reconnect, which routes through the
    // EXISTING single-flight reconnect() and its 500ms→10s backoff rather than a
    // parallel recovery path. Anti-churn is preserved by a cooldown, so escalations
    // cannot chain into a hot loop, and by a cap — after which we go LOUD rather
    // than quiet: stderr is loud to nobody who is watching, so we also tell the
    // MODEL, downstream, that its notifications are dead.
    t.onerror = (e) => {
      const msg = String(e);
      log('upstream error:', msg);
      if (!/Maximum reconnection attempts \(\d+\) exceeded/.test(msg)) return;
      const now = Date.now();
      if (now - lastEscalation < ESCALATION_COOLDOWN_MS) {
        log(`notification stream exhausted again within cooldown — not escalating (${Math.round((now - lastEscalation) / 1000)}s since last)`);
        return;
      }
      lastEscalation = now;
      escalations++;
      if (escalations > MAX_ESCALATIONS) {
        log(`NOTIFICATION STREAM DEAD — ${escalations - 1} reconnect escalations exhausted; server→client notifications are NOT arriving`);
        notifyDownstream(
          'error',
          `ours proxy: the server→client notification stream could not be re-established after ${escalations - 1} attempts. Tool calls still work, but you will NOT receive new-mail or other server notifications until this session reconnects. Treat any "waiting for a message" as unreliable.`,
        );
        return;
      }
      log(`notification stream exhausted its retries — escalating to a full reconnect (${escalations}/${MAX_ESCALATIONS})`);
      dropUpstream(t, 'notification stream exhausted');
    };
    t.onclose = () => dropUpstream(t, 'closed');
  }

  const isInitId = (id: string | number): boolean =>
    initializeMsg != null && initializeMsg.id === id;

  async function openUpstream(): Promise<void> {
    if (opts.ensureDaemon) await opts.ensureDaemon().catch((e) => log('ensureDaemon:', String(e)));
    const t = new StreamableHTTPClientTransport(url, {
      // DEFECT B. The standalone GET SSE IS reconnectable, but the SDK default
      // maxRetries is 2 — i.e. two CONSECUTIVE failed reconnect attempts, at
      // 1000ms and 1500ms, so it gives up ~2.5s in. (The counter resets to 0 on
      // each fresh stream failure, so this is a consecutive-failure budget, not a
      // per-process one.) Under the observed pressure — nine disconnects in forty
      // minutes — that budget is walked to exhaustion, and on exhaustion the SDK
      // calls onerror and stops: notifications die permanently while tool calls
      // keep working. An agent in that state is deaf but not dead, with no signal
      // to anyone. 5 retries with the same backoff buys ~15s of in-place recovery
      // instead of ~2.5s, and escalation below handles the rest.
      reconnectionOptions: {
        initialReconnectionDelay: 1000,
        maxReconnectionDelay: 30_000,
        reconnectionDelayGrowFactor: 1.5,
        maxRetries: 5,
      },
      requestInit: {
        headers: {
          'x-ours-lease-token': leaseToken,
          'x-ours-client-pid': String(clientPid),
          // API access token (Part B). Omitted in `open` mode (opts.apiToken
          // undefined); in owner mode the same-user proxy read it from the
          // 0600 file, in shared mode from OURS_API_TOKEN. A wrong/missing
          // token under owner/shared surfaces as a 401 on connect.
          ...(opts.apiToken ? { 'x-ours-api-token': opts.apiToken } : {}),
        },
      },
    });
    attachUp(t);
    await t.start();
    if (protocolVersion) { try { t.setProtocolVersion?.(protocolVersion); } catch { /* ignore */ } }
    up = t;
  }

  async function sendSynthetic(msg: AnyMsg, swallow: boolean): Promise<void> {
    if (swallow && msg.id !== undefined) swallowIds.add(msg.id as string | number);
    await up!.send(msg as unknown as JSONRPCMessage);
  }

  // Re-establish a usable upstream session after a genuine drop, transparently
  // to Claude: replay initialize (so a new daemon session exists), send
  // initialized (so the daemon's notification SSE reopens), then re-bind the
  // identity (daemon auto-reclaims it from the dead prior session, no force).
  async function reconnect(): Promise<void> {
    if (reconnecting || shuttingDown) return;
    reconnecting = true;
    let delay = 500;
    for (;;) {
      if (shuttingDown) { reconnecting = false; return; }
      try {
        await openUpstream();
        if (initializeMsg) {
          const synId = `${SYN_INIT}${rebindSeq}`;
          synInitIds.add(synId);
          await sendSynthetic({ ...initializeMsg, id: synId }, true);
          await up!.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as unknown as JSONRPCMessage);
        }
        if (boundIdentity) {
          const rid = `__ours_proxy_rebind_${++rebindSeq}__`;
          await sendSynthetic(
            { jsonrpc: '2.0', id: rid, method: 'tools/call', params: { name: 'choose_identity', arguments: { name: boundIdentity } } },
            true,
          );
        }
        upReady = true;
        const queued = pendingToUp.splice(0);
        for (const m of queued) await up!.send(m).catch((e) => log('flush failed:', String(e)));
        log('upstream reconnected', boundIdentity ? `(re-bound "${boundIdentity}")` : '');
        // A healthy session earns a fresh escalation budget — otherwise the cap
        // would be a per-process total and a long-lived proxy would eventually go
        // loud over unrelated blips spread across hours.
        escalations = 0;
        reconnecting = false;
        return;
      } catch (e) {
        log('reconnect attempt failed:', String(e));
        await sleep(delay);
        delay = Math.min(Math.floor(delay * 1.5), 10_000);
      }
    }
  }

  async function shutdown(code: number): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    // No release on stop: the daemon keeps the lease so an idle resume re-attaches.
    // Cleanup is the daemon's pid-liveness reclaim-on-contention.
    try { await up?.close(); } catch { /* ignore */ }
    try { await down.close(); } catch { /* ignore */ }
    process.exit(code);
  }
  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));

  // Dying silently is the failure mode being fixed everywhere else here, so do not
  // let the proxy itself do it. Node's default for an unhandled rejection is to
  // exit 1, which downstream sees only as "the connector went away", with no reason
  // recorded anywhere. Log loudly and keep serving: a proxy still up with one
  // failed operation is strictly better than one that vanished without a trace.
  process.on('unhandledRejection', (reason) => {
    log('UNHANDLED REJECTION (proxy stays up):', reason instanceof Error ? (reason.stack ?? reason.message) : String(reason));
  });
  process.on('uncaughtException', (err) => {
    log('UNCAUGHT EXCEPTION (proxy stays up):', err?.stack ?? String(err));
  });

  // Read the daemon's self-report (non-blocking: a missing/old daemon must not
  // break startup). If the package versions differ, set versionAdvisory — it
  // will be appended to the MCP initialize result's instructions so the model
  // sees it once at session start. Never refuse, never auto-restart.
  async function runCompatHandshake(): Promise<void> {
    const sd = new URL(url.href);
    sd.pathname = '/state-dir';
    let info: { version?: unknown };
    try {
      const r = await fetch(sd, { signal: AbortSignal.timeout(3000) });
      info = (await r.json()) as typeof info;
    } catch (e) {
      log('compat handshake: could not read daemon /state-dir, proceeding:', String(e));
      return;
    }
    versionAdvisory = formatVersionAdvisory({
      selfVersion: VERSION,
      daemonVersion: typeof info?.version === 'string' ? info.version : null,
    });
    if (versionAdvisory) log(versionAdvisory);
  }

  // ---- boot: upstream first (with retry), then accept Claude ----------------
  // Open the daemon session before processing Claude's stdin so the very first
  // `initialize` passes straight through and establishes the binding-capable
  // session. If the daemon is briefly unavailable, retry — downstream frames
  // buffer until it's ready.
  void (async () => {
    if (opts.ensureDaemon) await opts.ensureDaemon().catch((e) => log('ensureDaemon:', String(e)));
    await runCompatHandshake();
    let delay = 500;
    for (;;) {
      try { await openUpstream(); break; }
      catch (e) { log('initial upstream connect failed, retrying:', String(e)); await sleep(delay); delay = Math.min(Math.floor(delay * 1.5), 10_000); }
    }
    upReady = true;
    // Check the transport instead of asserting `up!` on every iteration. This loop
    // awaits, and dropUpstream() can null `up` during that await — the next
    // iteration would then evaluate `.send` on null and throw a SYNCHRONOUS
    // TypeError. The trailing .catch() structurally cannot catch it: the throw
    // happens on property access, before send() returns a promise. Inside this
    // void-discarded async IIFE that becomes an unhandled rejection, and Node's
    // default for that is to exit 1. (The identical line in reconnect() survives
    // only because it sits inside a try/catch.) Unflushed frames are re-queued
    // rather than dropped.
    const queued = pendingToUp.splice(0);
    for (let i = 0; i < queued.length; i++) {
      const t = currentUp();
      if (!t) { pendingToUp.unshift(...queued.slice(i)); break; }
      await t.send(queued[i]).catch((err: unknown) => log('flush failed:', String(err)));
    }
    log(`upstream ready — stdio ⇄ ${url.href}`);
  })();

  // Seed the bound identity from this Claude session's restore record BEFORE any
  // downstream frame can arrive (down.start() is below), so the initial-boot
  // self-recovery has it ready when Claude's `initialized` flows. Synchronous fs;
  // no daemon needed. A true first-ever boot finds no record and stays unbound.
  if (claudeSessionId) {
    pruneRestores();
    const seed = loadRestore();
    if (seed) {
      boundIdentity = seed;
      log('session-restore: found prior binding for this session — will self-recover', `"${seed}"`);
    }
  } else if (AUTORESTORE_OPT_OUT) {
    log('session-restore: disabled via OURS_NO_AUTORESTORE — pure in-memory binding');
  }

  await down.start();
  log('proxy started (stdio transport up)');
}

function asList(raw: JSONRPCMessage): JSONRPCMessage[] {
  return Array.isArray(raw) ? raw : [raw];
}
