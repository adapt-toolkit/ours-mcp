// Named daemon instances for the boot service (systemd unit / launchd agent).
//
// WHY. `ours-mcp install-service` used to write ONE fixed unit — `ours.service`
// on Linux, `solutions.adaptframework.ours` on macOS — with the resolved port,
// broker and state directory baked in as environment. That is correct for the
// one shared daemon, but it makes a SECOND, deliberately isolated daemon
// impossible to persist: running `OURS_CONFIG=<other> ours-mcp install-service`
// silently OVERWRITES the shared daemon's unit with the other daemon's port and
// state directory, and the two then fight over one definition.
//
// A daemon may now carry an instance NAME (env OURS_SERVICE_NAME, else the
// config file's `serviceName`). With a name, the unit/label is suffixed so each
// daemon owns a distinct definition and neither can clobber the other. WITHOUT a
// name — the default, and every deployment that exists today — the unit and
// label are byte-for-byte what they always were, so this is backward compatible.
//
// The name is validated, never sanitized-by-guessing: an unusable name is an
// error the caller reports, not a silently rewritten string that installs a unit
// the operator did not ask for. It becomes part of a filename and of a systemd
// unit name, so control characters, separators, whitespace and path parts are
// all refused outright (the same class of check ours-cowork applies before it
// writes a service definition).

export const DEFAULT_SYSTEMD_UNIT = 'ours.service';
export const DEFAULT_LAUNCHD_LABEL = 'solutions.adaptframework.ours';

// 1–32 chars, alphanumeric with interior hyphens/underscores. No dots (they read
// as launchd label separators), no slashes, no whitespace, no control bytes.
const INSTANCE_RE = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,30}[A-Za-z0-9])?$/;

export interface InstanceResult {
  ok: boolean;
  /** '' means "the default, unnamed daemon" — the historical single-unit behaviour. */
  name: string;
  reason?: string;
}

// Normalize a raw instance selection. Empty/undefined is VALID and means the
// default unnamed daemon; anything else must satisfy INSTANCE_RE.
export function normalizeInstanceName(raw: unknown): InstanceResult {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return { ok: true, name: '' };
  if (s.length > 32) {
    return { ok: false, name: '', reason: 'service name must be 32 characters or fewer' };
  }
  if (!INSTANCE_RE.test(s)) {
    return {
      ok: false,
      name: '',
      reason: 'service name must be 1–32 characters of letters, digits, hyphen or underscore, starting and ending with a letter or digit',
    };
  }
  return { ok: true, name: s };
}

// The systemd user unit for an instance. '' → the historical `ours.service`.
export function systemdUnitName(instance = ''): string {
  const { ok, name } = normalizeInstanceName(instance);
  if (!ok || !name) return DEFAULT_SYSTEMD_UNIT;
  return `ours-${name}.service`;
}

// The launchd label for an instance. '' → the historical bare label.
export function launchdLabel(instance = ''): string {
  const { ok, name } = normalizeInstanceName(instance);
  if (!ok || !name) return DEFAULT_LAUNCHD_LABEL;
  return `${DEFAULT_LAUNCHD_LABEL}.${name}`;
}

// A human label for messages: the shared daemon, or a named one.
export function serviceDescription(instance = ''): string {
  const { ok, name } = normalizeInstanceName(instance);
  return ok && name
    ? `ours MCP daemon (instance "${name}") — secure agent-to-agent messaging over ADAPT`
    : 'ours MCP daemon (secure agent-to-agent messaging over ADAPT)';
}

export interface ServiceDefinitionInput {
  instance?: string;
  /** Exact config selected for a named instance. Unnamed services keep the historical implicit default. */
  configPath?: string;
  port: number;
  brokerUrl: string;
  stateDir: string;
  execPath: string;
  /** Absolute path to the installed cli.js that the unit runs with `serve`. */
  self: string;
  /** launchd only — where the agent's stdout/stderr go. */
  logPath?: string;
}

// The systemd unit text. Emitted here rather than inline in cli.ts so the baked
// environment (the part that makes two daemons isolated or not) is directly
// testable without touching a real systemd.
export function buildSystemdUnit(input: ServiceDefinitionInput): string {
  const instance = normalizeInstanceName(input.instance).name;
  const instanceEnv = instance ? `Environment=OURS_SERVICE_NAME=${instance}\n` : '';
  const configEnv = instance && input.configPath ? `Environment=OURS_CONFIG=${input.configPath}\n` : '';
  return `[Unit]
Description=${serviceDescription(instance)}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${input.execPath} ${input.self} serve
Environment=OURS_TRANSPORT=http
Environment=OURS_PORT=${input.port}
Environment=OURS_BROKER_URL=${input.brokerUrl}
Environment=OURS_STATE_DIR=${input.stateDir}
${configEnv}${instanceEnv}Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`;
}

// The launchd agent plist text. Same reasoning as buildSystemdUnit.
export function buildLaunchdPlist(input: ServiceDefinitionInput): string {
  const instance = normalizeInstanceName(input.instance).name;
  const instanceEnv = instance
    ? `    <key>OURS_SERVICE_NAME</key><string>${instance}</string>\n`
    : '';
  const configEnv = instance && input.configPath
    ? `    <key>OURS_CONFIG</key><string>${input.configPath}</string>\n`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${launchdLabel(instance)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${input.execPath}</string>
    <string>${input.self}</string>
    <string>serve</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>OURS_TRANSPORT</key><string>http</string>
    <key>OURS_PORT</key><string>${input.port}</string>
    <key>OURS_BROKER_URL</key><string>${input.brokerUrl}</string>
    <key>OURS_STATE_DIR</key><string>${input.stateDir}</string>
${configEnv}${instanceEnv}  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${input.logPath ?? ''}</string>
  <key>StandardErrorPath</key><string>${input.logPath ?? ''}</string>
</dict>
</plist>
`;
}
