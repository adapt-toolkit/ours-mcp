// Shared runtime configuration for the ours MCP server and CLI.
//
// Per field, precedence is: explicit env var > config.json > built-in default.
// The config file lives at OURS_CONFIG, else <home>/.ours/config.json — a
// FIXED home location, independent of a configured stateDir (no chicken-and-egg).

import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join, dirname, basename } from 'node:path';

export interface OursConfig {
  brokerUrl: string;
  port: number;
  stateDir: string;
  gcIntervalMs: number;
  // When true, the proxy auto-spawns the daemon if port `port` is not
  // answering. Off by default: an unreachable daemon is reported as an error
  // ("start it with `ours-mcp start`") instead of being silently launched.
  autoStart: boolean;
}

export const DEFAULT_CONFIG: OursConfig = {
  brokerUrl: 'wss://ours.network/broker_new',
  port: 3050,
  stateDir: resolve(homedir(), '.ours'),
  gcIntervalMs: 3_600_000,
  autoStart: false,
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
  return out;
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
  };
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
