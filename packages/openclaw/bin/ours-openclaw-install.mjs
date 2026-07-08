#!/usr/bin/env node
// Friendly front-door for `npm i -g @ours.network/openclaw` — the second of the two
// install commands:
//
//     npm i -g @ours.network/openclaw
//     ours-openclaw-install
//
// It resolves this package's own install.sh (which ensures the ours daemon, registers
// the `ours` MCP server under mcp.servers + per-identity webhook routes in
// ~/.openclaw/openclaw.json, installs the skills, and starts the reactivity watcher)
// and runs it — no env-var gymnastics. The MCP server + skill install immediately. Wake-on-mail
// is NOT set up here: the agent enables it in-session (bind an identity, then the ours skill
// writes that identity's route + does a one-time gateway restart, with the user's OK, and starts
// the watcher). Everything is idempotent, so re-running is safe.
//
// (Power-user escape hatch, not the story and never prompted: --identities "A B" writes routes +
// starts watchers at install time for identities that already exist. Prefer the in-session flow.)
//
// Usage:
//   ours-openclaw-install [--port 18789] [--openclaw-dir DIR] [--skip-daemon] [--skip-watcher]
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const PKG = dirname(dirname(fileURLToPath(import.meta.url))); // bin/.. → package root
const INSTALL = join(PKG, 'install.sh');

const argv = process.argv.slice(2);
const opts = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--identities' || a === '-i') opts.identities = argv[++i];
  else if (a === '--port') opts.port = argv[++i];
  else if (a === '--openclaw-dir') opts.openclawDir = argv[++i];
  else if (a === '--skip-daemon') opts.skipDaemon = true;
  else if (a === '--skip-watcher') opts.skipWatcher = true;
  else if (a === '--help' || a === '-h') { help(); process.exit(0); }
  else { console.error(`ours-openclaw-install: unknown argument "${a}"`); help(); process.exit(2); }
}

function help() {
  console.log(`ours-openclaw-install — set up the ours.network plugin for OpenClaw.

  ours-openclaw-install [options]

Sets up the daemon + the ours MCP server + the skill. It asks nothing about identities or
wake-on-mail: you enable wake in-session from your agent (bind an identity, then ask the ours
skill to "wake me on new mail" — it writes that identity's route and does a one-time gateway
restart, with your OK).

Options:
      --port <n>            OpenClaw gateway port (default 18789)
      --openclaw-dir <dir>  OpenClaw config+skills root (default ~/.openclaw)
      --skip-daemon         do not install/start the ours daemon
      --skip-watcher        do not start the reactivity watcher
  -h, --help                show this help

Idempotent: safe to re-run. After it finishes, run \`openclaw gateway restart\`.`);
}

if (!existsSync(INSTALL)) {
  console.error(`ours-openclaw-install: cannot find install.sh at ${INSTALL}`);
  process.exit(1);
}

// install.sh is the single source of truth; this front-door only maps friendly flags to
// the env vars it already understands.
const env = { ...process.env };
if (opts.identities != null) env.CONNECTOR_IDENTITIES = opts.identities;
if (opts.port) env.OURS_WEBHOOK_PORT = opts.port;
if (opts.openclawDir) env.OPENCLAW_DIR = opts.openclawDir;
if (opts.skipDaemon) env.OURS_INSTALL_SKIP_DAEMON = '1';
if (opts.skipWatcher) env.OURS_INSTALL_SKIP_WATCHER = '1';

const res = spawnSync('bash', [INSTALL], { stdio: 'inherit', env });
if (res.error) { console.error(`ours-openclaw-install: ${res.error.message}`); process.exit(1); }
process.exit(res.status ?? 0);
