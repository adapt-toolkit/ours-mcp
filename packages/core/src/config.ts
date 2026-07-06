// Shared runtime configuration for the ours MCP server and CLI.
//
// Per field, precedence is: explicit env var > config.json > built-in default.
// The config file lives at OURS_CONFIG, else <home>/.ours/config.json — a
// FIXED home location, independent of a configured stateDir (no chicken-and-egg).

import * as fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve, join, dirname, basename } from 'node:path';

// How reachable the daemon's local HTTP surface (the messaging + notification
// endpoints) is to OTHER local OS users. The port always binds 127.0.0.1, so
// any local user can reach it at TCP level; visibility governs whether a bearer
// token is required and where it comes from:
//   owner  (DEFAULT) — token auto-generated to an owner-only 0600 file; only
//                      the daemon owner can read it → effectively same-user-only.
//   shared           — token MUST be operator-supplied (OURS_API_TOKEN / config)
//                      so it can be distributed to cross-user fleet agents; the
//                      daemon refuses to start without one.
//   open             — no token; reachable by all local users (legacy behavior).
export type ApiVisibility = 'owner' | 'shared' | 'open';
export const API_VISIBILITIES: ApiVisibility[] = ['owner', 'shared', 'open'];

export interface OursConfig {
  brokerUrl: string;
  port: number;
  stateDir: string;
  gcIntervalMs: number;
  // When true, the proxy auto-spawns the daemon if port `port` is not
  // answering. Off by default: an unreachable daemon is reported as an error
  // ("start it with `ours-mcp start`") instead of being silently launched.
  autoStart: boolean;
  // Cross-user visibility of the HTTP surface (see ApiVisibility). Default owner.
  apiVisibility: ApiVisibility;
  // Explicit bearer token. Highest-priority source is OURS_API_TOKEN; this is
  // the config-file equivalent. Empty/undefined → resolve from file or generate
  // (owner mode only). Required for `shared`.
  apiToken?: string;
}

export const DEFAULT_CONFIG: OursConfig = {
  brokerUrl: 'wss://broker1.ours.network',
  port: 3050,
  stateDir: resolve(homedir(), '.ours'),
  gcIntervalMs: 3_600_000,
  autoStart: false,
  apiVisibility: 'owner',
};

export function configPath(): string {
  return process.env.OURS_CONFIG ?? join(homedir(), '.ours', 'config.json');
}

function readFileConfig(): Partial<OursConfig> {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath(), 'utf8');
  } catch {
    return {};
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
  const out: Partial<OursConfig> = {};
  if (typeof parsed.brokerUrl === 'string') out.brokerUrl = parsed.brokerUrl;
  if (typeof parsed.port === 'number' && Number.isFinite(parsed.port)) out.port = parsed.port;
  if (typeof parsed.stateDir === 'string') out.stateDir = resolve(parsed.stateDir);
  if (typeof parsed.gcIntervalMs === 'number' && Number.isFinite(parsed.gcIntervalMs)) {
    out.gcIntervalMs = parsed.gcIntervalMs;
  }
  if (typeof parsed.autoStart === 'boolean') out.autoStart = parsed.autoStart;
  if (typeof parsed.apiVisibility === 'string' && (API_VISIBILITIES as string[]).includes(parsed.apiVisibility)) {
    out.apiVisibility = parsed.apiVisibility as ApiVisibility;
  }
  if (typeof parsed.apiToken === 'string' && parsed.apiToken.trim()) out.apiToken = parsed.apiToken.trim();
  return out;
}

function envVisibility(): ApiVisibility | undefined {
  const v = process.env.OURS_API_VISIBILITY?.trim().toLowerCase();
  return v && (API_VISIBILITIES as string[]).includes(v) ? (v as ApiVisibility) : undefined;
}

function envBool(name: string): boolean | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  return v === '1' || v.toLowerCase() === 'true';
}

function envInt(name: string): number | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? undefined : n;
}

export function loadConfig(): OursConfig {
  const file = readFileConfig();
  return {
    brokerUrl: process.env.OURS_BROKER_URL ?? file.brokerUrl ?? DEFAULT_CONFIG.brokerUrl,
    port: envInt('OURS_PORT') ?? file.port ?? DEFAULT_CONFIG.port,
    stateDir: resolve(process.env.OURS_STATE_DIR ?? file.stateDir ?? DEFAULT_CONFIG.stateDir),
    gcIntervalMs: envInt('OURS_GC_INTERVAL_MS') ?? file.gcIntervalMs ?? DEFAULT_CONFIG.gcIntervalMs,
    autoStart: envBool('OURS_AUTOSTART') ?? file.autoStart ?? DEFAULT_CONFIG.autoStart,
    apiVisibility: envVisibility() ?? file.apiVisibility ?? DEFAULT_CONFIG.apiVisibility,
    apiToken: process.env.OURS_API_TOKEN?.trim() || file.apiToken,
  };
}

// ----- API access token ------------------------------------------------------
// The bearer token that gates the daemon's messaging + notification HTTP
// surface (Part B). ONE token authenticates everything: the `/mcp` transport,
// `/identities`, and the `/identities/<name>/notifications` wake stream — so a
// cross-user watcher and a cross-user proxy share a single auth path.
//
// Resolution precedence (highest first): OURS_API_TOKEN env → config apiToken →
// the persisted owner-only file. In `owner` mode the daemon generates the file
// on first boot (0600, so only the owner can read it → same-user-only); clients
// run by the owner read the same file. Cross-user sharing is opt-in: the
// operator sets OURS_API_TOKEN (or config apiToken) on the daemon AND the fleet
// agents, distributing one known secret.
export const API_TOKEN_FILENAME = 'daemon-token';

export function apiTokenPath(cfg: Pick<OursConfig, 'stateDir'>): string {
  return join(cfg.stateDir, API_TOKEN_FILENAME);
}

// A token explicitly supplied by the operator (env or config) — as opposed to
// an auto-generated file token. `shared` mode requires one of these.
export function explicitApiToken(cfg: Pick<OursConfig, 'apiToken'>): string | undefined {
  const env = process.env.OURS_API_TOKEN?.trim();
  if (env) return env;
  const c = cfg.apiToken?.trim();
  return c || undefined;
}

export interface ResolvedApiToken {
  token: string;
  source: 'env' | 'config' | 'file' | 'generated';
}

// Resolve the token for a client (proxy/watch/status) or the daemon. With
// generate=true (daemon, owner mode) a missing token is minted and persisted
// 0600. Otherwise a missing token yields null (open mode, or a client that
// cannot read the owner's file). Never throws on a permission/parse error —
// callers decide how to react (the daemon aborts, watch fails loud on a 401).
export function resolveApiToken(
  cfg: Pick<OursConfig, 'stateDir' | 'apiToken'>,
  opts: { generate?: boolean } = {},
): ResolvedApiToken | null {
  const env = process.env.OURS_API_TOKEN?.trim();
  if (env) return { token: env, source: 'env' };
  const c = cfg.apiToken?.trim();
  if (c) return { token: c, source: 'config' };
  const path = apiTokenPath(cfg);
  try {
    const fromFile = fs.readFileSync(path, 'utf8').trim();
    if (fromFile) return { token: fromFile, source: 'file' };
  } catch {
    /* absent or unreadable (e.g. another user's 0600 file) — fall through */
  }
  if (!opts.generate) return null;
  const token = randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(dirname(path), { recursive: true });
    fs.writeFileSync(path, token + '\n', { mode: 0o600 });
    fs.chmodSync(path, 0o600); // enforce even if a prior umask/file relaxed it
  } catch {
    /* best effort: platforms without POSIX modes still get an in-memory token */
  }
  return { token, source: 'generated' };
}

export function writeConfig(cfg: OursConfig): string {
  const path = configPath();
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(path, 0o600);
  } catch {
    /* best effort: platforms without POSIX modes */
  }
  return path;
}

// ----- .ours-identity (workspace identity pin) -----------------------------
// The per-workspace pin file read by the SessionStart/UserPromptSubmit hook
// (see hooks/runner.ts). The pin is ADVISORY — the hook asks the user before
// binding or creating anything; the file alone never triggers an action.
// Keys mirror identity creation/binding:
//   identity          (required) the identity name this workspace belongs to
//   force             (optional) once the user approves binding, evicting
//                     another holder is pre-approved (no second confirmation)
//   expose_local      (optional, default true) publish to the local contact book
//   local_auto_accept (optional, default true) auto-accept local introductions

export const IDENTITY_FILENAME = '.ours-identity';

export interface IdentityFileOptions {
  name: string;
  force?: boolean;
  exposeLocal?: boolean;
  localAutoAccept?: boolean;
}

// Build the pin object. `force` is omitted when false to keep the common
// (non-evicting) file minimal; expose_local/local_auto_accept are always written
// so the chosen exposure is explicit rather than relying on hook defaults.
export function buildIdentityFile(opts: IdentityFileOptions): Record<string, unknown> {
  if (!opts.name.trim()) throw new Error('identity name must not be empty');
  const obj: Record<string, unknown> = { identity: opts.name.trim() };
  if (opts.force) obj.force = true;
  obj.expose_local = opts.exposeLocal ?? true;
  obj.local_auto_accept = opts.localAutoAccept ?? true;
  return obj;
}

// Resolve a user-supplied target to the file path. A target already named
// `.ours-identity` is used as-is; anything else is treated as the containing
// directory and the filename is appended.
export function resolveIdentityFilePath(target: string): string {
  const abs = resolve(target);
  return basename(abs) === IDENTITY_FILENAME ? abs : join(abs, IDENTITY_FILENAME);
}

// Write the pin into `target` (a directory or a full file path). Refuses to
// clobber an existing file unless overwrite=true. Returns the path written.
export function writeIdentityFile(target: string, opts: IdentityFileOptions, overwrite = false): string {
  const obj = buildIdentityFile(opts);
  const path = resolveIdentityFilePath(target);
  if (!overwrite && fs.existsSync(path)) {
    throw new Error(`${path} already exists — pass overwrite to replace it`);
  }
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(path, JSON.stringify(obj, null, 2) + '\n');
  return path;
}
