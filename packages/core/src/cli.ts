#!/usr/bin/env node
//
// ours-mcp — CLI / daemon manager for the ours daemon.
//
// The daemon runs as ONE long-lived background process — one shared ADAPT wrapper
// hosting N identities — and serves an HTTP API on http://localhost:<port>. This
// CLI starts/stops/inspects it, and is itself a CLIENT of that API.
//
// ⚠ IT NO LONGER SERVES /mcp, AND THIS CLI NO LONGER SPEAKS MCP TO ANYTHING.
// A Claude Code session does not connect to the daemon's port; it spawns
// `ours-mcp proxy`, which is the stdio MCP server (src/connector.ts) and reaches
// the daemon over the same API this CLI uses. Three consumers — the MCP server,
// this CLI, the SDK — one API, no special cases. Any code here that constructs an
// MCP client is a regression, not a shortcut.
//
// The plugin only *connects*; it never spawns the daemon unless `autoStart` is
// explicitly enabled (config.json / OURS_AUTOSTART).
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
//   OURS_SERVICE_NAME    boot-service instance name (default: none — the single
//                        shared `ours.service`). A name gives this daemon its own
//                        unit so an isolated second daemon cannot overwrite it.

import { spawn, spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import { homedir, userInfo } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import * as fs from 'node:fs';

// ⚠ NO MCP CLIENT IMPORTS. The CLI is a client of the daemon's HTTP API, exactly
// like the MCP server and the SDK — it does not speak MCP to anything. `Client`
// and `StreamableHTTPClientTransport` were here for create-root, which is now one
// typed call; re-adding either is a sign that something is reaching for /mcp again.
// ⚠ THE ./client SUBPATH, NOT THE ROOT BARREL. The root entry boots the ADAPT
// engine at module load and prints to STDOUT ("### Deleting 0 objects…", the
// reserved-identity line). Every CLI command that emits parseable output — any
// --json flag — is corrupted by that. ./client is the client-only entry and pulls
// none of it. Caught by test/voice-status-cli.test.mjs, which JSON.parses stdout.
import type { ConnectorOptions } from './connector.js';
import { OursClient, OursError } from '@ours.network/sdk/client';
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


import { sttStatus } from './transcribe';
import { linuxProcHasExited } from './process-state';
import {
  systemdUnitName, launchdLabel, normalizeInstanceName, buildSystemdUnit, buildLaunchdPlist,
} from './service-instance';
import { runVoiceSetup, VOICE_SETUP_HELP } from './voice-setup';
import {
  formatStartupProgress,
  readStartupProgress,
  renderStartupProgress,
  waitForStartup,
  type StartupWaitFailure,
} from './startup-progress';
import {
  parseApplicationArgs,
  assertApplicationCommand,
  resolveRuntimeAssociation,
  verifyRuntimeAssociation,
  type AssociatedApplication,
  type RuntimeAssociation,
} from './association';

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

let CLI_APPLICATION: AssociatedApplication | undefined;
let CLI_PARSE_ERROR: Error | null = null;
try {
  const parsed = parseApplicationArgs(process.argv.slice(2));
  CLI_APPLICATION = parsed.application;
  process.argv.splice(2, process.argv.length - 2, ...parsed.argv);
} catch (error) {
  CLI_PARSE_ERROR = error as Error;
}
const INITIAL_COMMAND = process.argv[2] ?? 'help';
const CLIENT_COMMAND = INITIAL_COMMAND === 'proxy' || INITIAL_COMMAND === 'watch';
// Lifecycle commands deliberately do not even read association state. They reject
// --application in main(), before performing an action.
const ACTIVE_ASSOCIATION: RuntimeAssociation | null = CLIENT_COMMAND
  ? resolveRuntimeAssociation(CLI_APPLICATION)
  : null;
const CONFIG = loadConfig({ application: CLIENT_COMMAND ? CLI_APPLICATION : undefined });
const STATE_DIR = CONFIG.stateDir;
const PORT = CONFIG.port;
// Bearer token for the daemon HTTP surface (Part B). Resolve it per request:
// during `start`, the CLI process exists BEFORE the daemon mints owner mode's
// 0600 token file. Caching the initial null would make an unauthenticated
// liveness probe look ready while the normal control surface was still unusable.
// Clients never mint it (generate:false) — only the daemon does.
const apiHeaders = (): Record<string, string> => {
  const token = resolveApiToken(CONFIG, { generate: false })?.token ?? null;
  return token ? { 'x-ours-api-token': token } : {};
};
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

// ----- the connector's session identity (proxy.ts:229-237, verbatim rules) ----
//
// THE PID IS THE CLIENT'S, NOT OURS. The harness tears this process down when it
// goes idle, so our own liveness says nothing about whether the session is still
// wanted; the daemon's lease reclaim keys on the CLIENT. The launcher passes it
// as OURS_CLIENT_PID (its own ppid); fall back to our ppid for a direct launch.
//
// ⚠ REJECT pids <= 1. macOS reparents orphans to launchd, and `pidAlive(1)` is
// always true — a lease held under pid 1 can never be reclaimed by anyone, ever.
const validPid = (n: number) => Number.isInteger(n) && n > 1;
const envClientPid = Number(process.env.OURS_CLIENT_PID);
const CLIENT_PID = validPid(envClientPid) ? envClientPid
  : validPid(process.ppid) ? process.ppid
  : process.pid;

// The lease this session holds. MUST be respawn-stable: an idle harness wake-up
// spawns a fresh connector, and a token derived from anything per-process would
// orphan the lease it left behind — which, with force binding staying, means the
// next session has to force past a lease that is nobody's.
const LEASE_TOKEN = (process.env.CLAUDE_CODE_SESSION_ID ?? '').trim() || `client:${CLIENT_PID}`;

// The identity a SUPERVISOR says this session belongs to. Read here beside the
// other two session-scoped inputs rather than through CONFIG: this is not daemon
// configuration (it is per-session, and the daemon has no opinion about it), so
// it never belongs in config.json or in the env > config > default precedence.
// Empty and unset are the same thing — nothing is seeded. See connector.ts's
// `seedBinding` for why the bind it performs is plain and can never evict.
const BIND_IDENTITY = (process.env.OURS_BIND_IDENTITY ?? '').trim() || undefined;

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
    // On Linux, kill(pid, 0) also succeeds for a zombie. Treat that already-exited
    // state as dead so `stop` does not sit through its full polling window while
    // init/systemd is merely waiting to reap the detached daemon.
    if (process.platform === 'linux') {
      try {
        if (linuxProcHasExited(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'))) return false;
      } catch {
        // The process may have disappeared between kill(0) and the proc read.
        try {
          process.kill(pid, 0);
        } catch {
          return false;
        }
      }
    }
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

function testTimeout(name: string, fallback: number): number {
  const value = Number(process.env[name] || '');
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const STARTUP_ABSOLUTE_MS = testTimeout('OURS_TEST_STARTUP_ABSOLUTE_MS', 180_000);
const STARTUP_INACTIVITY_MS = testTimeout('OURS_TEST_STARTUP_INACTIVITY_MS', 30_000);
const STARTUP_POLL_MS = testTimeout('OURS_TEST_STARTUP_POLL_MS', 400);

async function daemonReady(port: number): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.min(1_000, STARTUP_POLL_MS));
  try {
    // READY means the ordinary authenticated control surface works, not merely
    // that unauthenticated introspection or a TCP listener exists. In owner mode
    // apiHeaders() discovers the token file the child just minted; shared mode
    // uses the operator token; open mode intentionally sends no header.
    const resp = await fetch(`http://127.0.0.1:${port}/identities`, {
      signal: ctrl.signal,
      headers: apiHeaders(),
    });
    const ready = resp.ok;
    try { await resp.body?.cancel(); } catch { /* response status is sufficient */ }
    return ready;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function formatWaitDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.round(ms / 1_000)}s`;
}

function startupFailureMessage(
  reason: StartupWaitFailure,
  lastProgress: ReturnType<typeof readStartupProgress>,
): string {
  const last = lastProgress ? ` Last phase: ${formatStartupProgress(lastProgress)}.` : '';
  if (reason === 'process-exited' || reason === 'daemon-reported-failure') {
    return `daemon exited before becoming ready.${last}`;
  }
  if (reason === 'inactivity-timeout') {
    return (
      `daemon startup made no observable progress for ${formatWaitDuration(STARTUP_INACTIVITY_MS)}.` +
      `${last} The process is still running, but startup is stalled.`
    );
  }
  return (
    `daemon startup did not finish within ${formatWaitDuration(STARTUP_ABSOLUTE_MS)}.` +
    `${last} The bounded wait expired.`
  );
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
  const interactive = Boolean(process.stderr.isTTY);
  let progressShown = false;
  const result = await waitForStartup({
    pid: child.pid,
    absoluteMs: STARTUP_ABSOLUTE_MS,
    inactivityMs: STARTUP_INACTIVITY_MS,
    pollMs: STARTUP_POLL_MS,
    isProcessAlive: () => isAlive(child.pid!),
    isReady: () => daemonReady(PORT),
    readProgress: () => readStartupProgress(STATE_DIR),
    onProgress: (progress) => {
      progressShown = true;
      process.stderr.write(renderStartupProgress(progress, interactive));
    },
  });
  if (progressShown && interactive) process.stderr.write('\n');

  if (result.ok) {
    out(`ours-mcp is up: API on http://localhost:${PORT} (MCP is the "ours-mcp proxy" connector, not this port)`);
    out(`  broker: ${BROKER_URL}`);
    out(`  state:  ${STATE_DIR}`);
    out(`  logs:   ${LOG_PATH}`);
  } else {
    err(`${startupFailureMessage(result.reason, result.lastProgress)} Check ${LOG_PATH}.`);
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
      out(`  api:    http://localhost:${PORT} (reachable)`);
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
  out(`  api:    http://localhost:${PORT} ${up ? '(reachable)' : '(port not answering!)'}`);
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
    out('');
    out('  Voice-message transcription (STT). Leave provider empty to keep it off —');
    out('  agents then deterministically tell users voice messages cannot be read.');
    out('  No provider or model is assumed; model strings pass to your provider verbatim.');
    const sttProvider = (await rl.question(`  STT provider (openai-compatible / elevenlabs / deepgram / custom, empty=off) [${current.stt?.provider ?? ''}]: `)).trim() || (current.stt?.provider ?? '');
    let sttModel = current.stt?.model ?? '';
    let sttBaseUrl = current.stt?.baseUrl ?? '';
    if (sttProvider) {
      sttModel = await ask('STT model (verbatim, e.g. whisper-large-v3-turbo / scribe_v1 / nova-2)', sttModel);
      sttBaseUrl = await ask('STT base URL (required for openai-compatible; empty = provider default)', sttBaseUrl);
      out('  (API key is not echoed here. Run `ours-mcp voice-setup` for guided hidden input,');
      out('   or set OURS_STT_API_KEY for environment-only secret injection.)');
    }

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
    const stt = sttProvider
      ? {
          ...(current.stt ?? {}),
          provider: sttProvider,
          ...(sttModel ? { model: sttModel } : {}),
          ...(sttBaseUrl ? { baseUrl: sttBaseUrl } : {}),
        }
      : current.stt;   // never drop an existing block (incl. apiKey) on empty answer
    next = {
      brokerUrl,
      port,
      stateDir: resolve(stateDir),
      gcIntervalMs,
      autoStart,
      apiVisibility: apiVisibility as ApiVisibility,
      ...(current.apiToken ? { apiToken: current.apiToken } : {}),
      ...(stt ? { stt } : {}),
    };
  } finally {
    rl.close();
  }

  writeConfig(next);
  out('');
  out(`wrote ${path} (mode 0600):`);
  const display = {
    ...next,
    ...(next.apiToken ? { apiToken: '[redacted]' } : {}),
    ...(next.stt ? { stt: { ...next.stt, ...(next.stt.apiKey ? { apiKey: '[redacted]' } : {}) } } : {}),
  };
  out(JSON.stringify(display, null, 2));

  const shadowed = ([
    'OURS_BROKER_URL', 'OURS_PORT', 'OURS_STATE_DIR', 'OURS_GC_INTERVAL_MS',
    'OURS_AUTOSTART', 'OURS_API_VISIBILITY', 'OURS_API_TOKEN', 'OURS_STT_PROVIDER',
    'OURS_STT_API_KEY', 'OURS_STT_MODEL', 'OURS_STT_BASE_URL', 'OURS_STT_LANGUAGE',
  ] as const)
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

function cmdVoiceStatus(args: string[]): void {
  const status = sttStatus(CONFIG.stt);
  const provider = CONFIG.stt?.provider?.trim().toLowerCase() || null;
  const keySource = process.env.OURS_STT_API_KEY?.trim()
    ? 'environment'
    : CONFIG.stt?.apiKey?.trim()
      ? 'config'
      : 'missing';
  const result = status.ready
    ? { ready: true, provider: status.provider, apiKey: 'configured', keySource }
    : { ready: false, provider, apiKey: keySource === 'missing' ? 'missing' : 'configured', keySource, reason: status.reason };
  if (args.includes('--json')) {
    out(JSON.stringify(result));
    return;
  }
  if (result.ready) out(`voice transcription: ready (${result.provider}; API key from ${result.keySource})`);
  else out(`voice transcription: not ready — ${result.reason}`);
}

async function cmdVoiceSetup(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    out(VOICE_SETUP_HELP);
    return;
  }
  const allowed = new Set(['--dry-run']);
  const unknown = args.filter((arg) => !allowed.has(arg));
  if (unknown.length) {
    // Never reflect an unsupported argument: an operator may have mistaken a
    // provider key for a positional value, and argv must not become output.
    err('voice-setup: unsupported command-line option or argument');
    err('The provider key is never accepted as a CLI argument. Run `ours-mcp voice-setup --help`.');
    process.exitCode = 1;
    return;
  }

  const managed = runningPid() !== null;
  const reachable = await portOpen(PORT);
  const code = await runVoiceSetup({
    configFile: configPath(),
    env: process.env,
    dryRun: args.includes('--dry-run'),
    daemonState: managed ? 'managed' : reachable ? 'external' : 'stopped',
    apply: async () => {
      const restarted = spawnSync(process.execPath, [SELF, 'restart'], { stdio: 'inherit' });
      if (restarted.error || restarted.status !== 0) return { ok: false };
      const checked = spawnSync(process.execPath, [SELF, 'voice-status', '--json'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (checked.error || checked.status !== 0) return { ok: false };
      try {
        return { ok: JSON.parse(checked.stdout || '{}').ready === true };
      } catch {
        return { ok: false };
      }
    },
  });
  if (code !== 0) process.exitCode = code;
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
  // Was the last /mcp caller in the product: it opened an MCP session and called
  // the create_root_identity TOOL. The v3 and stable installers both run this, so
  // it would have broken new installs at the identity step.
  //
  // The COMMAND is kept: the owner's "lose create-root as a CLI command" ruling is
  // deferred, blocked on the stable installer call site.
  const client = new OursClient({
    url: `http://127.0.0.1:${PORT}`,
    apiToken: resolveApiToken(CONFIG, { generate: false })?.token,
    leaseToken: LEASE_TOKEN,
    clientPid: CLIENT_PID,
  });
  try {
    // skip_if_root_exists keeps re-runs idempotent: if a root already exists the
    // operation refuses with "a root identity already exists" (mapped to a quiet
    // exit-0 no-op below) rather than adopting `name` as a role (the interactive
    // behaviour).
    const r = await client.createRootIdentity({
      name,
      bio: '',
      exposeLocal: false,
      localAutoAccept: true,
      skipIfRootExists: true,
    });
    // Rendered from typed fields instead of scraped back out of MCP content. The
    // adoption counts matter: create-root pulls loose identities under the new root
    // and the installer output is where an operator learns that happened.
    const adoption = r.adopted.length > 0
      ? ` Adopted ${r.adopted.length} existing identit${r.adopted.length === 1 ? 'y' : 'ies'} as role(s): ${r.adopted.join(', ')}.`
      : '';
    const failures = r.failed.length > 0
      ? ` FAILED to adopt: ${r.failed.join(', ')} (see daemon log).`
      : '';
    // Asserted, not assumed: printing "root created" for a role would be a lie in
    // an installer.
    if (r.hierarchy !== 'root') {
      err(`create-root: expected a root, got ${r.hierarchy} under "${r.underRoot ?? '?'}" — refusing to report success.`);
      process.exit(1);
    }
    // ⚠ THE BASELINE SENTENCE, NOT A NEW ONE. The tool renders
    // `Created root identity "X" (cid) and bound it to this session.` and the CLI
    // printed it; porting the call is not licence to reword the output. The suffix
    // differs only in dropping the agent-directed monitor hint, which never made
    // sense on a CLI and was already stripped here by regex.
    out(`Created root identity "${r.info.name}" (${r.info.cid}) and bound it to this session.${adoption}${failures}`);
  } catch (e) {
    const text = e instanceof OursError
      ? e.message.split(/\n\nAsk the user\b/)[0].replace(/^create_root_identity failed: /, '').trim()
      : String(e instanceof Error ? e.message : e);
    if (e instanceof OursError && /a root identity already exists/i.test(text)) {
      out(`create-root: ${text.split('—')[0].trim()} — nothing to do.`);
      return;
    }
    err(`create-root failed: ${text}`);
    process.exit(1);
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
interface NotifyEvent { event?: string; from?: string; msg_id?: number | string; file_id?: number | string; filename?: string; bytes?: number | string; date?: string; queued?: number | string }

// The ONE place watch formats an event → stdout. Both the API path and the file
// fallback funnel through here so Claude Code's Monitor sees byte-identical lines
// no matter which transport delivered them.
//
// WAKE-EVENT WHITELIST (fixes the "watch deaf/garbled on e2e" bug): the daemon's
// notifications.log carries MANY event kinds — genuine inbound arrivals
// (message_received / file_received), intro bookkeeping (local_contact_request /
// pending_message), AND a large family of e2e/migration OBSERVABILITY events
// (e2e_app_recv, e2e_app_send, migration_active, migration_stalled,
// migration_deferred_flush, downgrade_refused, inbound_error, …). `watch` is the
// "one line per NEW INBOUND MESSAGE" wake source (README/DAEMON-INTEGRATION), so it
// must wake ONLY on the arrival events. The previous `else` fallthrough formatted
// EVERY non-intro event as "new message from <from>" — and since the observability
// events carry no `from`, a migrated (double-ratchet) message surfaced as a bogus
// "new message from ?" wake (the peer's own e2e_app_send even woke the SENDER), while
// the genuine message_received got drowned in noise. Now each surfaced event is
// classified explicitly; everything else is swallowed (watch stays quiet).
function emitNotify(name: string, msg: NotifyEvent): void {
  if (msg.event === 'message_received') {
    out(
      `[${name}] new message from ${msg.from ?? '?'}` +
        (msg.msg_id !== undefined ? ` (#${msg.msg_id})` : '') +
        (msg.date ? `  (${msg.date})` : ''),
    );
  } else if (msg.event === 'file_received') {
    out(
      `[${name}] new file ${msg.filename ?? '?'} from ${msg.from ?? '?'}` +
        (msg.bytes !== undefined ? ` (${msg.bytes} B)` : '') +
        (msg.file_id !== undefined ? ` (#${msg.file_id})` : '') +
        (msg.date ? `  (${msg.date})` : ''),
    );
  } else if (msg.event === 'local_contact_request') {
    out(`[${name}] pending local introduction from ${msg.from ?? '?'} — respond_to_introduction to approve/reject`);
  } else if (msg.event === 'pending_message') {
    out(`[${name}] ${msg.from ?? '?'} queued a message awaiting introduction approval (${msg.queued ?? '?'} queued)`);
  }
  // All other events (e2e_app_recv/send, migration_*, downgrade_refused,
  // sibling_contact_added, contact_restored, inbound_error, state_import_failed, …)
  // are NOT message arrivals — watch stays silent so it never fabricates a wake.
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
  //
  // PRIMING IS INSIDE THE LOOP, and that is the whole point. It used to run once
  // above it, where nothing caught it: fetchSince throws on any non-OK, non-401
  // response and on any network error, so a daemon that was merely restarting when
  // the watch started killed the watch outright — the exact transient case the
  // retry below exists to survive. `cursor === null` is the "not primed yet" state,
  // so a hiccup during priming is retried on the same backoff as any other.
  let cursor: number | null = null;
  let backoff = 0;
  for (;;) {
    try {
      if (cursor === null) cursor = (await fetchSince('tip')).cursor ?? 0;
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
            // Detached ON PURPOSE — each identity streams concurrently — which means
            // this promise has no awaiting caller and main()'s .catch cannot see it.
            // An unhandled rejection here TERMINATES the whole process on Node >=15,
            // so one identity's failure would silently take down the streams for
            // every other identity being watched. Nothing should reject now that
            // priming retries in-loop, and a 401 exits the process deliberately; if
            // one ever does, report it and forget the name so the next enumeration
            // tick re-arms it rather than leaving it permanently unwatched.
            void watchIdentityViaApi(name).catch((e) => {
              watching.delete(name);
              err(`ours-mcp watch: stream for "${name}" ended (${String((e as Error)?.message ?? e)}); will re-arm`);
            });
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
  await verifyRuntimeAssociation(
    ACTIVE_ASSOCIATION,
    CONFIG,
    resolveApiToken(CONFIG, { generate: false })?.token,
  );
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

// The boot-service definition this daemon owns. With no instance name (the
// default, and every deployment that predates named instances) these are exactly
// the historical `ours.service` / `solutions.adaptframework.ours`. A named
// instance gets its OWN unit so an isolated second daemon cannot overwrite the
// shared one — see src/service-instance.ts for the naming and validation rules.
const SERVICE_INSTANCE = CONFIG.serviceName ?? '';
const SYSTEMD_UNIT = systemdUnitName(SERVICE_INSTANCE);
const LAUNCHD_LABEL = launchdLabel(SERVICE_INSTANCE);

// An unusable instance name must FAIL the service commands rather than silently
// fall back to the shared unit — falling back is precisely the overwrite this
// feature exists to prevent.
function requireValidInstance(): string {
  const v = normalizeInstanceName(SERVICE_INSTANCE);
  if (!v.ok) {
    err(`invalid service name ${JSON.stringify(SERVICE_INSTANCE)}: ${v.reason}`);
    err('  set OURS_SERVICE_NAME (or "serviceName" in config.json) to a valid name, or unset it for the shared daemon.');
    process.exit(1);
  }
  return v.name;
}

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
  const unit = buildSystemdUnit({
    instance: SERVICE_INSTANCE,
    configPath: SERVICE_INSTANCE ? configPath() : undefined,
    port: PORT,
    brokerUrl: BROKER_URL,
    stateDir: STATE_DIR,
    execPath: process.execPath,
    self: SELF,
  });
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
  if (SERVICE_INSTANCE) out(`  instance: ${SERVICE_INSTANCE} (its own unit — the shared ours.service is untouched)`);
  out(`  status:  systemctl --user status ${SYSTEMD_UNIT}`);
  out(`  logs:    journalctl --user -u ${SYSTEMD_UNIT} -f`);
  out(`  remove:  ${removeHint()}`);
}

// The exact command that removes THIS unit. A named instance is only findable
// again when the same name is supplied, so spell it out rather than print a
// command that would target the shared daemon.
function removeHint(): string {
  return SERVICE_INSTANCE
    ? `OURS_SERVICE_NAME=${SERVICE_INSTANCE} ours-mcp uninstall-service`
    : 'ours-mcp uninstall-service';
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
  out(`ours-mcp service uninstalled (${SYSTEMD_UNIT}).`);
}

function installLaunchd(): void {
  const plistPath = launchdPlistPath();
  fs.mkdirSync(dirname(plistPath), { recursive: true });
  const plist = buildLaunchdPlist({
    instance: SERVICE_INSTANCE,
    configPath: SERVICE_INSTANCE ? configPath() : undefined,
    port: PORT,
    brokerUrl: BROKER_URL,
    stateDir: STATE_DIR,
    execPath: process.execPath,
    self: SELF,
    logPath: LOG_PATH,
  });
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
  if (SERVICE_INSTANCE) out(`  instance: ${SERVICE_INSTANCE} (label ${LAUNCHD_LABEL} — the shared agent is untouched)`);
  out(`  remove:  ${removeHint()}`);
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
  out(`ours-mcp service uninstalled (${LAUNCHD_LABEL}).`);
}

async function cmdInstallService(): Promise<void> {
  requireValidInstance();
  await cmdStop();
  if (process.platform === 'linux') return installSystemd();
  if (process.platform === 'darwin') return installLaunchd();
  err(`install-service: unsupported platform "${process.platform}" (only linux/systemd and macOS/launchd).`);
  process.exit(1);
}

function cmdUninstallService(): void {
  requireValidInstance();
  if (process.platform === 'linux') return uninstallSystemd();
  if (process.platform === 'darwin') return uninstallLaunchd();
  err(`uninstall-service: unsupported platform "${process.platform}".`);
  process.exit(1);
}

function usage(): void {
  out('ours-mcp — daemon for the ours MCP server');
  out('');
  out('Usage: ours-mcp <command>');
  out('  start     start in the background; show structured progress until ready');
  out('  stop      stop the running daemon');
  out('  restart   stop then start; healthy slow restores may take up to 3 minutes');
  out('  status    show whether the daemon is running (incl. CLI + running-daemon version)');
  out('  version   print the CLI version and the running daemon version (GET /version)');
  out('  setup     interactively edit the config file (broker / port / state dir / gc)');
  out('  voice-setup [--dry-run]  securely choose a provider and configure its hidden API key');
  out('  voice-status [--json]  check voice-transcription readiness (never prints the API key)');
  out('  serve     run in the foreground (used by start; handy for debugging)');
  out('  watch [--application claude-code|codex|hermes] [identity]  stream new inbound wake lines');
  out('  proxy [--application claude-code|codex|hermes]  per-session stdio shim → daemon');
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
  out('     a named instance (OURS_SERVICE_NAME / config serviceName) owns its OWN unit,');
  out('     so an isolated second daemon never overwrites the shared one. Default: shared.');
  out('');
  out('Config precedence (per field): env var > config.json > default.');
  out('  Client --application: explicit env > Nightly registry association > legacy config/default.');
  out('  config.json: OURS_CONFIG, else ~/.ours/config.json — edit with `setup`.');
  out('  env: OURS_BROKER_URL, OURS_PORT (3050), OURS_STATE_DIR (~/.ours), OURS_GC_INTERVAL_MS (3600000), OURS_AUTOSTART (off), OURS_SERVICE_NAME (none)');
  out('(install-service bakes the resolved config values into the service definition.)');
}

async function main(): Promise<void> {
  if (CLI_PARSE_ERROR) throw CLI_PARSE_ERROR;
  const cmd = process.argv[2] ?? 'help';
  assertApplicationCommand(CLI_APPLICATION, cmd);
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
    case 'voice-status':
    case 'stt-status':
      cmdVoiceStatus(process.argv.slice(3));
      break;
    case 'voice-setup':
    case 'stt-setup':
      await cmdVoiceSetup(process.argv.slice(3));
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
      await verifyRuntimeAssociation(
        ACTIVE_ASSOCIATION,
        CONFIG,
        resolveApiToken(CONFIG, { generate: false })?.token,
      );
      if (!CONFIG.autoStart && !(await portOpen(PORT))) {
        err(`ours-mcp daemon is not running on port ${PORT} — start it with \`ours-mcp start\`.`);
        err('(or enable auto-start: `ours-mcp setup` → autoStart, or OURS_AUTOSTART=1)');
        process.exit(1);
      }
      // NAME KEPT ON PURPOSE. This is no longer a proxy — it is the stdio MCP
      // server itself (./connector.js) — but `.mcp.json` and all three plugin
      // manifests launch `dist/cli.js proxy`, and renaming the verb in the same
      // change that rewrites what it does would fan this PR out across every
      // manifest for no behavioural gain. A rename is its own change, later.
      // ⚠ IMPORTED LAZILY. ./connector pulls the MCP tool registrars, which pull the
      // SDK root barrel, which BOOTS THE ADAPT ENGINE AT MODULE LOAD and prints to
      // STDOUT. A static import here corrupts every CLI command that emits parseable
      // output — caught by test/voice-status-cli.test.mjs, which JSON.parses stdout.
      // Only this one command needs the connector; nothing else may pay for it.
      const { runConnector } = await import(pathToFileURL(join(dirname(SELF), 'connector.js')).href) as { runConnector: (o: ConnectorOptions) => Promise<void> };
      await runConnector({
        // The ORIGIN only. There is no `/mcp` to point at any more: the daemon
        // does not mount it, because serve.ts no longer injects an MCP server.
        url: `http://127.0.0.1:${PORT}`,
        ensureDaemon: CONFIG.autoStart ? ensureDaemonRunning : undefined,
        apiToken: resolveApiToken(CONFIG, { generate: false })?.token,
        leaseToken: LEASE_TOKEN,
        clientPid: CLIENT_PID,
        version: CLI_VERSION,
        bindIdentity: BIND_IDENTITY,
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
