#!/usr/bin/env node
//
// ours-mcp — CLI / daemon manager for the ours MCP server.
//
// The server is meant to run as ONE long-lived background daemon (HTTP transport)
// that many Claude Code sessions connect to over http://localhost:<port>/mcp —
// one shared ADAPT wrapper hosting N identities. This CLI starts/stops/inspects
// that daemon. The Claude Code plugin only *connects*; it never spawns the
// server unless `autoStart` is explicitly enabled (config.json / OURS_AUTOSTART).
//
//   ours-mcp start     start the daemon in the background (idempotent)
//   ours-mcp stop      stop the running daemon
//   ours-mcp restart   stop then start
//   ours-mcp status    report whether the daemon is running + its config
//   ours-mcp setup     interactively edit the config file
//   ours-mcp serve     run the server in the FOREGROUND (used internally by
//                         `start`, and handy for debugging)
//
// Config precedence per field: env var > config.json (OURS_CONFIG, else
// ~/.ours/config.json) > default. Env vars override the file:
//   OURS_BROKER_URL      broker to connect to (default: public broker)
//   OURS_PORT            HTTP port (default 3050)
//   OURS_STATE_DIR       state + pid/log dir (default ~/.ours)
//   OURS_GC_INTERVAL_MS  message-GC interval in ms (default 3600000)
//   OURS_AUTOSTART       "1"/"true": proxy auto-spawns the daemon (default off)

import { spawn, spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import { homedir, userInfo } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import * as fs from 'node:fs';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as HttpClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  loadConfig,
  configPath,
  writeConfig,
  writeIdentityFile,
  buildIdentityFile,
  resolveIdentityFilePath,
  resolveApiToken,
  API_VISIBILITIES,
  IDENTITY_FILENAME,
  type OursConfig,
  type ApiVisibility,
} from './config';
import { runProxy } from './proxy';

// systemctl/journalctl --user (install-service / uninstall-service) locate the
// user bus via $XDG_RUNTIME_DIR/bus. sudo/su shells run inside the CALLING
// user's logind session, so the target user's shell has no XDG_RUNTIME_DIR even
// when linger keeps the user manager (and the bus socket at /run/user/<uid>/bus)
// alive. Derive the standard path once at startup: never override an existing
// value, and only when the dir actually exists — when it doesn't, the real
// problem is missing linger and the systemctl error is the right signal.
// (Mirror of adapt-toolkit/ours-fleet#9.)
if (!process.env.XDG_RUNTIME_DIR && typeof process.getuid === 'function') {
  const runDir = `/run/user/${process.getuid()}`;
  if (fs.existsSync(runDir)) process.env.XDG_RUNTIME_DIR = runDir;
}

const CONFIG = loadConfig();
const STATE_DIR = CONFIG.stateDir;
const PORT = CONFIG.port;
// Bearer token for the daemon HTTP surface (Part B). Clients never mint it
// (generate:false) — only the daemon does. owner mode: same-user reads the 0600
// file; shared mode: OURS_API_TOKEN/config; open mode: null (no header sent).
const API_TOKEN = resolveApiToken(CONFIG, { generate: false })?.token ?? null;
const apiHeaders = (): Record<string, string> => (API_TOKEN ? { 'x-ours-api-token': API_TOKEN } : {});
const BROKER_URL = CONFIG.brokerUrl;
const PID_PATH = join(STATE_DIR, 'daemon.pid');
const LOG_PATH = join(STATE_DIR, 'daemon.log');

const SELF = fileURLToPath(import.meta.url);
const out = (...p: unknown[]) => process.stdout.write(`${p.join(' ')}\n`);
const err = (...p: unknown[]) => process.stderr.write(`${p.join(' ')}\n`);

// Injected at build time by build.mjs (esbuild `define`) from package.json — the
// version of THIS CLI binary. The running daemon reports its OWN version over HTTP
// (GET /version); the two can differ when the package was upgraded but the daemon
// never restarted, so status surfaces both.
declare const __OURS_VERSION__: string;
const CLI_VERSION =
  typeof __OURS_VERSION__ !== 'undefined' ? __OURS_VERSION__ : '0.0.0-dev';

type DaemonInfo = { version?: string; compat?: string; protocol?: number };

// Ask the running daemon what it actually is (GET /version, falling back to the
// older /state-dir which also carries `version`). Returns null when the daemon is
// unreachable or too old to report a version at all.
async function fetchDaemonInfo(): Promise<DaemonInfo | null> {
  for (const path of ['/version', '/state-dir']) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);
      const resp = await fetch(`http://127.0.0.1:${PORT}${path}`, { signal: ctrl.signal });
      clearTimeout(t);
      if (resp.ok) {
        const body = (await resp.json()) as DaemonInfo;
        if (body && typeof body.version === 'string') return body;
      }
    } catch {
      /* try the next path / fall through to null */
    }
  }
  return null;
}

// Print the CLI version and the RUNNING daemon's reported version side by side,
// flagging a mismatch — the daemon keeps serving old code until restarted, so an
// upgraded package changes nothing until `ours-mcp restart`.
function reportVersions(info: DaemonInfo | null): void {
  out(`  cli:    v${CLI_VERSION}`);
  if (info?.version) {
    const stale = info.version !== CLI_VERSION;
    out(
      `  daemon: v${info.version}${info.compat ? ` (compat ${info.compat})` : ''}` +
        (stale ? `  ⚠ differs from CLI — \`ours-mcp restart\` to load v${CLI_VERSION}` : ''),
    );
  } else {
    out('  daemon: version unknown (running build predates /version — restart to update)');
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function readPid(): number | null {
  try {
    const n = parseInt(fs.readFileSync(PID_PATH, 'utf8').trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence check
    return true;
  } catch {
    return false;
  }
}

// Resolve the running daemon's pid, clearing a stale pidfile if the process is gone.
function runningPid(): number | null {
  const pid = readPid();
  if (pid && isAlive(pid)) return pid;
  if (pid) {
    try {
      fs.rmSync(PID_PATH, { force: true });
    } catch {
      /* ignore */
    }
  }
  return null;
}

function portOpen(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((res) => {
    const sock = connect({ host: '127.0.0.1', port });
    const done = (ok: boolean) => {
      sock.destroy();
      res(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

async function waitForPort(port: number, totalMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    if (await portOpen(port)) return true;
    await sleep(400);
  }
  return false;
}

async function cmdStart(): Promise<void> {
  const existing = runningPid();
  if (existing) {
    out(`ours-mcp is already running (pid ${existing}, port ${PORT}).`);
    return;
  }
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const logFd = fs.openSync(LOG_PATH, 'a');

  const child = spawn(process.execPath, [SELF, 'serve'], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      OURS_TRANSPORT: 'http',
      OURS_PORT: String(PORT),
      OURS_BROKER_URL: BROKER_URL,
      OURS_STATE_DIR: STATE_DIR,
    },
  });
  child.unref();

  if (!child.pid) {
    err('failed to spawn the daemon.');
    process.exit(1);
  }
  fs.writeFileSync(PID_PATH, String(child.pid));

  out(`starting ours-mcp (pid ${child.pid})…`);
  const ready = await waitForPort(PORT);
  if (ready) {
    out(`ours-mcp is up on http://localhost:${PORT}/mcp`);
    out(`  broker: ${BROKER_URL}`);
    out(`  state:  ${STATE_DIR}`);
    out(`  logs:   ${LOG_PATH}`);
  } else {
    err(`daemon started (pid ${child.pid}) but port ${PORT} did not open within 30s — check ${LOG_PATH}.`);
    process.exit(1);
  }
}

// Best-effort guarantee that the shared daemon is listening, for the proxy to
// connect to. Quiet by design: the proxy owns stdout (its MCP channel), so this
// must never write there. Races between concurrent proxies are benign — a second
// daemon loses the port bind and exits; one wins.
async function ensureDaemonRunning(): Promise<void> {
  if (await portOpen(PORT)) return;
  if (!runningPid()) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const logFd = fs.openSync(LOG_PATH, 'a');
    const child = spawn(process.execPath, [SELF, 'serve'], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: {
        ...process.env,
        OURS_TRANSPORT: 'http',
        OURS_PORT: String(PORT),
        OURS_BROKER_URL: BROKER_URL,
        OURS_STATE_DIR: STATE_DIR,
      },
    });
    child.unref();
    if (child.pid) {
      try { fs.writeFileSync(PID_PATH, String(child.pid)); } catch { /* ignore */ }
    }
  }
  await waitForPort(PORT);
}

async function cmdStop(): Promise<void> {
  const pid = runningPid();
  if (!pid) {
    out('ours-mcp is not running.');
    return;
  }
  out(`stopping ours-mcp (pid ${pid})…`);
  try {
    process.kill(pid, 'SIGTERM');
  } catch (e) {
    err(`failed to signal pid ${pid}: ${String(e)}`);
  }
  for (let i = 0; i < 25 && isAlive(pid); i++) await sleep(200);
  if (isAlive(pid)) {
    err(`pid ${pid} did not exit; sending SIGKILL.`);
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* ignore */
    }
  }
  try {
    fs.rmSync(PID_PATH, { force: true });
  } catch {
    /* ignore */
  }
  out('stopped.');
}

async function cmdStatus(): Promise<void> {
  const pid = runningPid();
  if (!pid) {
    if (await portOpen(PORT)) {
      const info = await fetchDaemonInfo();
      out('ours-mcp: running (no pidfile — likely a stale process or external launcher)');
      out(`  url:    http://localhost:${PORT}/mcp (reachable)`);
      reportVersions(info);
      return;
    }
    out('ours-mcp: stopped');
    out(`  cli:    v${CLI_VERSION}`);
    process.exitCode = 1;
    return;
  }
  const up = await portOpen(PORT);
  const info = up ? await fetchDaemonInfo() : null;
  out('ours-mcp: running');
  out(`  pid:    ${pid}`);
  out(`  url:    http://localhost:${PORT}/mcp ${up ? '(reachable)' : '(port not answering!)'}`);
  out(`  broker: ${BROKER_URL}`);
  out(`  state:  ${STATE_DIR}`);
  out(`  logs:   ${LOG_PATH}`);
  reportVersions(info);
}

// `ours-mcp version` / --version: print this binary's version, and the running
// daemon's if reachable (the number that actually matters for wire compatibility).
async function cmdVersion(): Promise<void> {
  out(`ours-mcp v${CLI_VERSION}`);
  if (await portOpen(PORT)) {
    const info = await fetchDaemonInfo();
    if (info?.version) {
      out(
        `running daemon: v${info.version}` +
          (info.version !== CLI_VERSION ? '  (differs — restart to update)' : ''),
      );
    } else {
      out('running daemon: version unknown (predates /version)');
    }
  } else {
    out('daemon: not running');
  }
}

// Interactively edit config.json. Shows the currently-resolved values, prompts
// for each (blank keeps the current), writes the file 0600, then — if the daemon
// is running — offers to restart it so the change takes effect.
async function cmdSetup(): Promise<void> {
  const current = loadConfig();
  const path = configPath();
  out(`ours-mcp setup — ${path}`);
  out('Enter a value, or press Enter to keep the current [bracketed] one.');
  out('');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let next: OursConfig;
  try {
    const ask = async (label: string, cur: string): Promise<string> => {
      const ans = (await rl.question(`  ${label} [${cur}]: `)).trim();
      return ans === '' ? cur : ans;
    };
    const brokerUrl = await ask('broker URL', current.brokerUrl);
    const portStr = await ask('HTTP port', String(current.port));
    const stateDir = await ask('state dir', current.stateDir);
    const gcStr = await ask('GC interval (ms)', String(current.gcIntervalMs));
    const autoStartStr = await ask('proxy auto-starts daemon (true/false)', String(current.autoStart));
    const visibilityStr = await ask('HTTP visibility (owner=same-user only / shared=cross-user w/ token / open=all local users)', current.apiVisibility);

    const port = parseInt(portStr, 10);
    if (!Number.isFinite(port) || port <= 0) {
      err(`invalid port: ${portStr}`);
      process.exit(1);
    }
    const gcIntervalMs = parseInt(gcStr, 10);
    if (!Number.isFinite(gcIntervalMs) || gcIntervalMs <= 0) {
      err(`invalid GC interval: ${gcStr}`);
      process.exit(1);
    }
    const autoStart = autoStartStr.toLowerCase() === 'true' || autoStartStr === '1';
    const apiVisibility = visibilityStr.trim().toLowerCase();
    if (!API_VISIBILITIES.includes(apiVisibility as ApiVisibility)) {
      err(`invalid visibility: ${visibilityStr} (expected one of ${API_VISIBILITIES.join(', ')})`);
      process.exit(1);
    }
    // Preserve an existing apiToken (e.g. a shared secret) across setup; it's not
    // prompted here to avoid echoing it to the terminal — edit config to change it.
    next = {
      brokerUrl,
      port,
      stateDir: resolve(stateDir),
      gcIntervalMs,
      autoStart,
      apiVisibility: apiVisibility as ApiVisibility,
      ...(current.apiToken ? { apiToken: current.apiToken } : {}),
    };
  } finally {
    rl.close();
  }

  writeConfig(next);
  out('');
  out(`wrote ${path} (mode 0600):`);
  out(JSON.stringify(next, null, 2));

  const shadowed = (['OURS_BROKER_URL', 'OURS_PORT', 'OURS_STATE_DIR', 'OURS_GC_INTERVAL_MS', 'OURS_AUTOSTART', 'OURS_API_VISIBILITY', 'OURS_API_TOKEN'] as const)
    .filter((k) => process.env[k] !== undefined);
  if (shadowed.length) {
    out('');
    out(`note: these env vars are set and OVERRIDE the file at runtime: ${shadowed.join(', ')}`);
  }

  const pid = runningPid();
  if (!pid) return;
  const rl2 = createInterface({ input: process.stdin, output: process.stdout });
  let restart = false;
  try {
    const ans = (await rl2.question(`\ndaemon is running (pid ${pid}); restart now to apply? [y/N]: `)).trim().toLowerCase();
    restart = ans === 'y' || ans === 'yes';
  } finally {
    rl2.close();
  }
  if (!restart) {
    out('not restarting — changes apply on the next `ours-mcp restart`.');
    return;
  }
  // Stop with the CURRENT settings (this process still holds the pre-change
  // constants, so its pidfile path matches the running daemon), then start a
  // FRESH process so the new config.json is loaded for the new daemon.
  await cmdStop();
  const r = spawnSync(process.execPath, [SELF, 'start'], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

// ─── define-local-identity-file ──────────────────────────────────────────────
//
// Write a `.ours-identity` workspace pin. Two modes:
//   • interactive (default): a 4-question survey on stdin, then write to CWD.
//   • non-interactive: any of --name/--force-bind/--local-book/--auto-accept-local
//     present switches off the prompts; values come from flags (sane defaults for
//     the rest). This is the path Claude/scripts call directly.
//
//   ours-mcp define-local-identity-file
//   ours-mcp define-local-identity-file --name "Foo" --force-bind --local-book --auto-accept-local
//
// Flags:
//   --name <s>             identity name (required in non-interactive mode)
//   --force-bind           pin pre-authorizes force-eviction      (default off)
//   --local-book           publish to the host-local contact book (default on)
//   --auto-accept-local    auto-accept local introductions         (default on)
//   --no-force-bind / --no-local-book / --no-auto-accept-local   negations
//   --dir <path> | --path <file>   where to write (default: CWD/.ours-identity)
//   --overwrite            replace an existing file
//   --print                print the JSON without writing
type FlagState = { value?: boolean; set: boolean };
function flagPair(argv: string[], on: string, off: string): FlagState {
  if (argv.includes(off)) return { value: false, set: true };
  if (argv.includes(on)) return { value: true, set: true };
  return { value: undefined, set: false };
}
function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

async function cmdDefineLocalIdentityFile(argv: string[]): Promise<void> {
  const name = flagValue(argv, '--name');
  const force = flagPair(argv, '--force-bind', '--no-force-bind');
  const localBook = flagPair(argv, '--local-book', '--no-local-book');
  const autoAccept = flagPair(argv, '--auto-accept-local', '--no-auto-accept-local');
  const overwrite = argv.includes('--overwrite');
  const print = argv.includes('--print');
  const target = flagValue(argv, '--path') ?? flagValue(argv, '--dir') ?? process.cwd();

  // Non-interactive iff the caller passed any field flag.
  const nonInteractive =
    name !== undefined || force.set || localBook.set || autoAccept.set || print;

  let opts: { name: string; force?: boolean; exposeLocal?: boolean; localAutoAccept?: boolean };
  if (nonInteractive) {
    if (!name || !name.trim()) {
      err('define-local-identity-file: --name is required in non-interactive mode.');
      process.exit(1);
    }
    opts = {
      name: name.trim(),
      force: force.value ?? false,
      exposeLocal: localBook.value ?? true,
      localAutoAccept: autoAccept.value ?? true,
    };
  } else {
    opts = await runIdentitySurvey();
  }

  if (print) {
    out(JSON.stringify(buildIdentityFile(opts), null, 2));
    return;
  }

  const path = resolveIdentityFilePath(target);
  if (!overwrite && fs.existsSync(path)) {
    if (nonInteractive) {
      err(`define-local-identity-file: ${path} already exists — pass --overwrite to replace it.`);
      process.exit(1);
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let ok = false;
    try {
      const ans = (await rl.question(`\n${path} already exists — overwrite? [y/N]: `)).trim().toLowerCase();
      ok = ans === 'y' || ans === 'yes';
    } finally {
      rl.close();
    }
    if (!ok) {
      out('aborted — nothing written.');
      return;
    }
  }

  const written = writeIdentityFile(target, opts, true);
  out('');
  out(`wrote ${written}:`);
  out(JSON.stringify(buildIdentityFile(opts), null, 2));
}

// The interactive survey: 4 questions, each with a [bracketed] default.
async function runIdentitySurvey(): Promise<{
  name: string;
  force: boolean;
  exposeLocal: boolean;
  localAutoAccept: boolean;
}> {
  out(`ours-mcp define-local-identity-file — interactive`);
  out(`Answer the prompts; the result is written to ${join(process.cwd(), IDENTITY_FILENAME)}.`);
  out('');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const askYesNo = async (label: string, def: boolean): Promise<boolean> => {
      const hint = def ? 'Y/n' : 'y/N';
      const ans = (await rl.question(`  ${label} [${hint}]: `)).trim().toLowerCase();
      if (ans === '') return def;
      return ans === 'y' || ans === 'yes';
    };
    let name = '';
    while (!name) {
      name = (await rl.question('  Identity name: ')).trim();
      if (!name) out('  (name is required)');
    }
    const force = await askYesNo('Force-bind (pin pre-authorizes evicting another session)?', false);
    const exposeLocal = await askYesNo('Add to the host-local contact book?', true);
    const localAutoAccept = await askYesNo('Auto-accept local invites/introductions?', true);
    return { name, force, exposeLocal, localAutoAccept };
  } finally {
    rl.close();
  }
}

// ─── create-root (installer seam: deterministic first-run root identity) ─────
//
// `ours-mcp create-root "<name>"` creates THE root human identity by calling the
// running daemon's create_root_identity MCP tool over loopback. The installer
// invokes this at FIRST install so the root exists deterministically — no agent
// has to discover a skill and decide to call it. Idempotent for scripts: when a
// root already exists this is a quiet no-op (exit 0); a genuine failure (invalid
// or duplicate NAME, unreachable daemon) exits non-zero.
async function cmdCreateRoot(argv: string[]): Promise<void> {
  const name = (argv[0] ?? '').trim();
  if (!name || name.startsWith('--')) {
    err('usage: ours-mcp create-root "<your name>"');
    process.exit(1);
  }
  if (!(await portOpen(PORT))) {
    err(`create-root: the daemon is not running on port ${PORT} — start it with \`ours-mcp start\`.`);
    process.exit(1);
  }
  const transport = new HttpClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
    requestInit: { headers: apiHeaders() },
  });
  const client = new Client({ name: 'ours-mcp-cli', version: CLI_VERSION });
  try {
    await client.connect(transport);
    const r = await client.callTool({ name: 'create_root_identity', arguments: { name } });
    const text = (Array.isArray(r.content) ? (r.content as Array<{ text?: unknown }>) : [])
      .map((c) => (typeof c.text === 'string' ? c.text : ''))
      .join(' ')
      .split('\n\nAsk the user:')[0] // the monitor hint is agent-directed; meaningless on a CLI
      .replace(/^create_root_identity failed: /, '')
      .trim();
    if (r.isError) {
      if (/a root identity already exists/i.test(text)) {
        out(`create-root: ${text.split('—')[0].trim()} — nothing to do.`);
        return;
      }
      err(`create-root failed: ${text}`);
      process.exit(1);
    }
    out(text);
  } finally {
    try { await transport.terminateSession(); } catch { /* ignore */ }
    try { await client.close(); } catch { /* ignore */ }
  }
}

// ─── watch (Claude Code host seam: the wake source for `Monitor`) ────────────
//
// `ours-mcp watch [identity]` tails every identity's notifications.log and
// prints ONE line per newly-arrived message. It is the wake source a Claude Code
// `Monitor` blocks on. Scope it to a single identity to match the session that
// owns it (notifications are per-identity):
//
//     Monitor({ command: "ours-mcp watch <identity>", persistent: true })
//
// New mail → a new stdout line → the agent wakes and runs get_messages. The line
// carries only sender + id (no body — the body never leaves the packet on disk).
// Only NEW arrivals are emitted (offsets start at end-of-file); the pre-existing
// backlog is the SessionStart hook's job. Stdout carries events only — every
// status line goes to stderr, since Monitor turns each stdout line into a
// notification.
// A content-free arrival event as it appears on notifications.log / the API.
interface NotifyEvent { event?: string; from?: string; msg_id?: number | string; date?: string; queued?: number | string }

// The ONE place watch formats an event → stdout. Both the API path and the file
// fallback funnel through here so Claude Code's Monitor sees byte-identical lines
// no matter which transport delivered them.
function emitNotify(name: string, msg: NotifyEvent): void {
  if (msg.event === 'local_contact_request') {
    out(`[${name}] pending local introduction from ${msg.from ?? '?'} — respond_to_introduction to approve/reject`);
  } else if (msg.event === 'pending_message') {
    out(`[${name}] ${msg.from ?? '?'} queued a message awaiting introduction approval (${msg.queued ?? '?'} queued)`);
  } else {
    out(
      `[${name}] new message from ${msg.from ?? '?'}` +
        (msg.msg_id !== undefined ? ` (#${msg.msg_id})` : '') +
        (msg.date ? `  (${msg.date})` : ''),
    );
  }
}

// A watcher that cannot watch must look BROKEN, not armed: print one clear line
// and exit non-zero so a Monitor surfaces the failure instead of spinning deaf.
function watchFailLoud(message: string): never {
  err(`ours-mcp watch: ${message}`);
  process.exit(1);
}

// Ask the running daemon where its state lives (GET /state-dir on the HTTP port),
// so watch follows the daemon's STATE_DIR even under an override or when running
// as a different user than the daemon owner. Returns null when the daemon is
// unreachable (not started / older build) — the caller then decides fallback.
// /state-dir is unauthenticated in every visibility mode, so no token is needed.
async function probeDaemonStateDir(): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const resp = await fetch(`http://127.0.0.1:${PORT}/state-dir`, { signal: ctrl.signal });
    clearTimeout(t);
    if (resp.ok) {
      const body = (await resp.json()) as { stateDir?: unknown };
      if (typeof body.stateDir === 'string' && body.stateDir) return resolve(body.stateDir);
      return STATE_DIR;
    }
  } catch {
    /* daemon down or pre-/state-dir build */
  }
  return null;
}

const NOTIFY_URL = (name: string) => `http://127.0.0.1:${PORT}/identities/${encodeURIComponent(name)}/notifications`;

// Long-poll one identity's notification stream over the daemon API, forever.
// A 401 is fatal (token set-but-rejected) — fail loud, per the brief. Transient
// network errors (daemon restart) are retried with backoff, never silently
// swapped for a file read that a cross-user watcher couldn't do anyway.
async function watchIdentityViaApi(name: string): Promise<void> {
  const fetchSince = async (since: string): Promise<{ cursor?: number; events?: NotifyEvent[] }> => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 35_000); // > the daemon's 25s hold
    let resp: Response;
    try {
      resp = await fetch(`${NOTIFY_URL(name)}?since=${since}`, { headers: apiHeaders(), signal: ctrl.signal });
    } finally {
      clearTimeout(t);
    }
    if (resp.status === 401) {
      watchFailLoud(
        `daemon rejected the API token (401) for identity "${name}". ` +
          'Set OURS_API_TOKEN to the daemon\'s token (shared mode) or run watch as the daemon owner (owner mode).',
      );
    }
    if (!resp.ok) throw new Error(`daemon returned HTTP ${resp.status}`);
    return (await resp.json()) as { cursor?: number; events?: NotifyEvent[] };
  };

  // Prime at the current tip — emit nothing for the existing backlog.
  let cursor = (await fetchSince('tip')).cursor ?? 0;
  let backoff = 0;
  for (;;) {
    try {
      const body = await fetchSince(String(cursor));
      backoff = 0;
      if (Array.isArray(body.events)) for (const ev of body.events) emitNotify(name, ev);
      if (typeof body.cursor === 'number') cursor = body.cursor;
    } catch (e) {
      // Transient (daemon bounce / abort). Retry with capped backoff; a 401
      // already exited above, so this never masks an auth failure.
      backoff = Math.min(backoff + 1000, 5000);
      err(`ours-mcp watch: notifications stream for "${name}" hiccupped (${String((e as Error)?.message ?? e)}), retrying…`);
      await sleep(backoff);
    }
  }
}

// Watch over the API. For a single identity we stream it directly; for "all",
// we enumerate via GET /identities and re-enumerate periodically so identities
// created mid-session get picked up (the file path used to notice new dirs).
async function watchViaApi(which?: string): Promise<void> {
  if (which) {
    await watchIdentityViaApi(which);
    return;
  }
  const watching = new Set<string>();
  for (;;) {
    try {
      const resp = await fetch(`http://127.0.0.1:${PORT}/identities`, { headers: apiHeaders() });
      if (resp.status === 401) {
        watchFailLoud('daemon rejected the API token (401). Set OURS_API_TOKEN or run watch as the daemon owner.');
      }
      if (resp.ok) {
        const body = (await resp.json()) as { identities?: Array<{ name?: unknown }> };
        for (const ent of body.identities ?? []) {
          const name = typeof ent?.name === 'string' ? ent.name : undefined;
          if (name && !watching.has(name)) {
            watching.add(name);
            void watchIdentityViaApi(name); // runs until a 401 (exits) or forever
          }
        }
      }
    } catch {
      /* transient enumeration error — try again next tick */
    }
    await sleep(3000);
  }
}

const isPermLike = (e: unknown): boolean => {
  const code = (e as NodeJS.ErrnoException)?.code;
  return code === 'EACCES' || code === 'EPERM';
};

// FILE FALLBACK — only when the daemon API is unreachable. Any EACCES/EPERM (the
// cross-user deaf-agent root cause) or a missing/unreadable watch target fails
// LOUDLY with a non-zero exit — the old code swallowed these and spun forever.
function watchViaFileFallback(watchDir: string, which?: string): void {
  // Readiness probe up front: if we can't even list the watch dir (or the target
  // identity's dir), we cannot watch — say so and exit, don't pretend to be armed.
  try {
    fs.readdirSync(watchDir);
  } catch (e) {
    watchFailLoud(
      `cannot watch — the daemon API is unreachable AND ${watchDir} is not readable ` +
        `(${(e as NodeJS.ErrnoException)?.code ?? e}). On a multi-user host, run watch as the ` +
        'daemon owner, or enable the daemon API (start the daemon) so watch can stream over HTTP.',
    );
  }
  if (which) {
    try {
      fs.readdirSync(join(watchDir, which));
    } catch (e) {
      watchFailLoud(
        `cannot watch identity "${which}" — ${join(watchDir, which)} is not readable ` +
          `(${(e as NodeJS.ErrnoException)?.code ?? e}). Is the daemon running and the name correct?`,
      );
    }
  }

  const offsets = new Map<string, number>(); // notifications.log path -> bytes already emitted
  const scan = (initial: boolean) => {
    let names: string[];
    try {
      names = fs.readdirSync(watchDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch (e) {
      if (isPermLike(e)) watchFailLoud(`lost read access to ${watchDir} (${(e as NodeJS.ErrnoException).code}) — cannot watch.`);
      return; // ENOENT: dir vanished transiently — retry next tick
    }
    for (const name of names) {
      if (which && name !== which) continue;
      const logPath = join(watchDir, name, 'notifications.log');
      let size: number;
      try {
        size = fs.statSync(logPath).size;
      } catch (e) {
        if (isPermLike(e)) watchFailLoud(`cannot read ${logPath} (${(e as NodeJS.ErrnoException).code}) — cannot watch identity "${name}".`);
        continue; // ENOENT: no notifications.log for this identity yet (benign)
      }
      let seen = offsets.get(logPath);
      if (seen === undefined) {
        seen = initial ? size : 0;
        offsets.set(logPath, seen);
        if (initial) continue;
      }
      if (size <= seen) {
        if (size < seen) offsets.set(logPath, size); // truncated/rotated
        continue;
      }
      let chunk: string;
      try {
        const fd = fs.openSync(logPath, 'r');
        const buf = Buffer.alloc(size - seen);
        fs.readSync(fd, buf, 0, buf.length, seen);
        fs.closeSync(fd);
        chunk = buf.toString('utf8');
      } catch (e) {
        if (isPermLike(e)) watchFailLoud(`cannot read ${logPath} (${(e as NodeJS.ErrnoException).code}) — cannot watch identity "${name}".`);
        continue;
      }
      offsets.set(logPath, size);
      for (const line of chunk.split('\n')) {
        if (!line.trim()) continue;
        try {
          emitNotify(name, JSON.parse(line) as NotifyEvent);
        } catch {
          /* skip malformed line */
        }
      }
    }
  };

  err(`ours-mcp watch: daemon API unreachable — falling back to file poll of ${watchDir} (Ctrl-C to stop)`);
  scan(true); // prime offsets at EOF — emit nothing for the existing backlog
  const timer = setInterval(() => scan(false), 1000);
  const stop = () => { clearInterval(timer); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

// Capability probe: does this daemon expose the notification API? Returns 'api'
// (stream over HTTP), 'file' (old daemon without the endpoint → file fallback),
// or fails loud on a rejected token (401 = set-but-wrong, per the brief). Uses
// GET /identities — present iff the daemon supports the notification surface.
async function probeNotifApi(): Promise<'api' | 'file'> {
  try {
    const resp = await fetch(`http://127.0.0.1:${PORT}/identities`, { headers: apiHeaders() });
    if (resp.status === 401) {
      watchFailLoud(
        'daemon rejected the API token (401). Set OURS_API_TOKEN to the daemon\'s token ' +
          '(shared mode) or run watch as the daemon owner (owner mode).',
      );
    }
    if (resp.status === 404) return 'file'; // older daemon without the endpoint
    if (resp.ok) return 'api';
    return 'file';
  } catch {
    return 'file'; // daemon vanished between probes — let the fallback decide
  }
}

async function cmdWatch(which?: string): Promise<void> {
  const stop = () => process.exit(0);
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  // Prefer the daemon HTTP API (works cross-user; the file lives under the
  // daemon owner's 0700 home). Fall back to a file poll ONLY when the daemon is
  // unreachable or too old to expose the endpoint — and make that fallback fail
  // loud rather than spin deaf.
  const daemonUp = (await probeDaemonStateDir()) !== null;
  if (daemonUp && (await probeNotifApi()) === 'api') {
    err(`ours-mcp watch: streaming ${which ? `identity "${which}"` : 'all identities'} from the daemon API on port ${PORT} (Ctrl-C to stop)`);
    await watchViaApi(which);
    return;
  }
  watchViaFileFallback(STATE_DIR, which);
}

const SYSTEMD_UNIT = 'ours.service';
const LAUNCHD_LABEL = 'solutions.adaptframework.ours';

function systemdUnitPath(): string {
  return join(homedir(), '.config', 'systemd', 'user', SYSTEMD_UNIT);
}

function launchdPlistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

function run(cmd: string, args: string[]): boolean {
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  return r.status === 0;
}

function installSystemd(): void {
  const unitPath = systemdUnitPath();
  fs.mkdirSync(dirname(unitPath), { recursive: true });
  const unit = `[Unit]
Description=ours MCP daemon (secure agent-to-agent messaging over ADAPT)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${process.execPath} ${SELF} serve
Environment=OURS_TRANSPORT=http
Environment=OURS_PORT=${PORT}
Environment=OURS_BROKER_URL=${BROKER_URL}
Environment=OURS_STATE_DIR=${STATE_DIR}
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`;
  fs.writeFileSync(unitPath, unit);
  out(`wrote ${unitPath}`);

  run('systemctl', ['--user', 'daemon-reload']);
  if (!run('systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT])) {
    err('failed to enable/start the service via systemctl --user.');
    if (!process.env.XDG_RUNTIME_DIR) {
      // Reachable after the startup fallback only when /run/user/<uid> is
      // missing — no user manager, i.e. linger is off and no session is active.
      err(`hint: no user runtime dir — enable linger: sudo loginctl enable-linger ${userInfo().username}`);
      err('      (if linger is already on: export XDG_RUNTIME_DIR=/run/user/$(id -u))');
    }
    process.exit(1);
  }
  if (!run('loginctl', ['enable-linger', userInfo().username])) {
    err('warning: could not enable linger — the daemon may not start until you log in.');
    err(`  run manually: loginctl enable-linger ${userInfo().username}`);
  }
  out('');
  out(`ours-mcp installed as a systemd user service and started.`);
  out(`  status:  systemctl --user status ${SYSTEMD_UNIT}`);
  out(`  logs:    journalctl --user -u ${SYSTEMD_UNIT} -f`);
  out(`  remove:  ours-mcp uninstall-service`);
}

function uninstallSystemd(): void {
  run('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT]);
  const unitPath = systemdUnitPath();
  try {
    fs.rmSync(unitPath, { force: true });
    out(`removed ${unitPath}`);
  } catch (e) {
    err(`failed to remove ${unitPath}: ${String(e)}`);
  }
  run('systemctl', ['--user', 'daemon-reload']);
  out('ours-mcp service uninstalled.');
}

function installLaunchd(): void {
  const plistPath = launchdPlistPath();
  fs.mkdirSync(dirname(plistPath), { recursive: true });
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${SELF}</string>
    <string>serve</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>OURS_TRANSPORT</key><string>http</string>
    <key>OURS_PORT</key><string>${PORT}</string>
    <key>OURS_BROKER_URL</key><string>${BROKER_URL}</string>
    <key>OURS_STATE_DIR</key><string>${STATE_DIR}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${LOG_PATH}</string>
  <key>StandardErrorPath</key><string>${LOG_PATH}</string>
</dict>
</plist>
`;
  fs.writeFileSync(plistPath, plist);
  out(`wrote ${plistPath}`);

  const domain = `gui/${process.getuid!()}`;
  spawnSync('launchctl', ['bootout', domain, plistPath], { stdio: 'ignore' });
  if (!run('launchctl', ['bootstrap', domain, plistPath])) {
    err('failed to load the launchd agent.');
    process.exit(1);
  }
  out('');
  out('ours-mcp installed as a launchd agent and started.');
  out(`  remove:  ours-mcp uninstall-service`);
}

function uninstallLaunchd(): void {
  const plistPath = launchdPlistPath();
  const domain = `gui/${process.getuid!()}`;
  spawnSync('launchctl', ['bootout', domain, plistPath], { stdio: 'ignore' });
  try {
    fs.rmSync(plistPath, { force: true });
    out(`removed ${plistPath}`);
  } catch (e) {
    err(`failed to remove ${plistPath}: ${String(e)}`);
  }
  out('ours-mcp service uninstalled.');
}

async function cmdInstallService(): Promise<void> {
  await cmdStop();
  if (process.platform === 'linux') return installSystemd();
  if (process.platform === 'darwin') return installLaunchd();
  err(`install-service: unsupported platform "${process.platform}" (only linux/systemd and macOS/launchd).`);
  process.exit(1);
}

function cmdUninstallService(): void {
  if (process.platform === 'linux') return uninstallSystemd();
  if (process.platform === 'darwin') return uninstallLaunchd();
  err(`uninstall-service: unsupported platform "${process.platform}".`);
  process.exit(1);
}

function usage(): void {
  out('ours-mcp — daemon for the ours MCP server');
  out('');
  out('Usage: ours-mcp <command>');
  out('  start     start the daemon in the background');
  out('  stop      stop the running daemon');
  out('  restart   stop then start');
  out('  status    show whether the daemon is running (incl. CLI + running-daemon version)');
  out('  version   print the CLI version and the running daemon version (GET /version)');
  out('  setup     interactively edit the config file (broker / port / state dir / gc)');
  out('  serve     run in the foreground (used by start; handy for debugging)');
  out('  watch [identity]  stream one line per new inbound message (wake source for a Monitor)');
  out('  proxy     per-session stdio shim → daemon (stable binding; for the MCP client config)');
  out('');
  out('  create-root "<name>"   create THE root human identity (one per host) via the running');
  out('                         daemon — quiet no-op if a root already exists (installer seam)');
  out('');
  out('  define-local-identity-file   write a .ours-identity workspace pin');
  out('    interactive (default): 4-question survey, writes to CWD');
  out('    scripted: --name <s> [--force-bind] [--local-book] [--auto-accept-local]');
  out('              negate with --no-force-bind / --no-local-book / --no-auto-accept-local');
  out('              --dir <path> | --path <file> (default CWD) · --overwrite · --print');
  out('');
  out('  install-service    install + start a boot-persistent service (systemd/launchd)');
  out('  uninstall-service  stop + remove that service');
  out('');
  out('Config precedence (per field): env var > config.json > default.');
  out('  config.json: OURS_CONFIG, else ~/.ours/config.json — edit with `setup`.');
  out('  env: OURS_BROKER_URL, OURS_PORT (3050), OURS_STATE_DIR (~/.ours), OURS_GC_INTERVAL_MS (3600000), OURS_AUTOSTART (off)');
  out('(install-service bakes the resolved config values into the service definition.)');
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'help';
  switch (cmd) {
    case 'serve':
    case 'run':
      // Run the server in this process. index.js auto-starts on import and reads
      // OURS_TRANSPORT; ensure HTTP unless the caller overrode it. The computed
      // specifier keeps esbuild from bundling the server into the CLI — it's loaded
      // at runtime from the sibling dist/index.js.
      if (!process.env.OURS_TRANSPORT) process.env.OURS_TRANSPORT = 'http';
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(PID_PATH, String(process.pid));
      {
        const cleanup = () => {
          try {
            fs.rmSync(PID_PATH, { force: true });
          } catch {
            /* ignore */
          }
        };
        process.on('exit', cleanup);
        for (const sig of ['SIGTERM', 'SIGINT'] as const) {
          process.on(sig, () => {
            cleanup();
            process.exit(0);
          });
        }
      }
      await import(pathToFileURL(join(dirname(SELF), 'index.js')).href);
      break;
    case 'start':
      await cmdStart();
      break;
    case 'stop':
      await cmdStop();
      break;
    case 'restart':
      await cmdStop();
      await cmdStart();
      break;
    case 'status':
      await cmdStatus();
      break;
    case 'version':
    case '--version':
    case '-v':
      await cmdVersion();
      break;
    case 'setup':
      await cmdSetup();
      break;
    case 'create-root':
      await cmdCreateRoot(process.argv.slice(3));
      break;
    case 'define-local-identity-file':
      await cmdDefineLocalIdentityFile(process.argv.slice(3));
      break;
    case 'watch':
      await cmdWatch(process.argv[3]);
      break;
    case 'proxy':
      // Per-session stdio shim in front of the shared daemon. Claude Code spawns
      // this over stdio (stable for the whole session, no 15-min re-handshake);
      // it bridges to the daemon's http endpoint and keeps the identity binding
      // stable across the daemon's session lifetime. Runs until stdin closes.
      //
      // The daemon is expected to be running already (`ours-mcp start` /
      // install-service). With autoStart off (the default) an unreachable
      // daemon is a hard startup error; with it on, the proxy spawns the
      // daemon on demand before each connect attempt.
      if (!CONFIG.autoStart && !(await portOpen(PORT))) {
        err(`ours-mcp daemon is not running on port ${PORT} — start it with \`ours-mcp start\`.`);
        err('(or enable auto-start: `ours-mcp setup` → autoStart, or OURS_AUTOSTART=1)');
        process.exit(1);
      }
      await runProxy({
        url: `http://127.0.0.1:${PORT}/mcp`,
        ensureDaemon: CONFIG.autoStart ? ensureDaemonRunning : undefined,
        stateDir: STATE_DIR,
        apiToken: API_TOKEN ?? undefined,
      });
      break;
    case 'install-service':
      await cmdInstallService();
      break;
    case 'uninstall-service':
      cmdUninstallService();
      break;
    case 'help':
    case '--help':
    case '-h':
      usage();
      break;
    default:
      err(`unknown command: ${cmd}\n`);
      usage();
      process.exit(1);
  }
}

main().catch((e) => {
  err(`ours-mcp error: ${e?.stack ?? e}`);
  process.exit(1);
});
