#!/usr/bin/env node
// Friendly front-door for `npm i -g @ours.network/hermes` — the second of the two
// install commands:
//
//     npm i -g @ours.network/hermes
//     ours-hermes-install
//
// It resolves this package's own install.sh (which ensures the ours daemon, registers
// the `ours` MCP server + the `ours-wake` webhook route in ~/.hermes/config.yaml,
// installs the skills, and starts the reactivity watcher) and runs it — no env-var
// gymnastics. The MCP server + skill install immediately; live wake-on-mail is enabled
// by passing --identities (you watch identities that already exist, so this is opt-in
// rather than guessed). Everything is idempotent, so re-running is safe.
//
// Usage:
//   ours-hermes-install [--identities "Agent1 Agent2"] [--port 8644]
//                       [--hermes-dir DIR] [--skip-daemon] [--skip-watcher]
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
  else if (a === '--hermes-dir') opts.hermesDir = argv[++i];
  else if (a === '--skip-daemon') opts.skipDaemon = true;
  else if (a === '--skip-watcher') opts.skipWatcher = true;
  else if (a === '--help' || a === '-h') { help(); process.exit(0); }
  else { console.error(`ours-hermes-install: unknown argument "${a}"`); help(); process.exit(2); }
}

function help() {
  console.log(`ours-hermes-install — set up the ours.network plugin for Hermes.

  ours-hermes-install [options]

Options:
  -i, --identities "A B"   ours identities to watch for wake-on-mail (space-separated)
      --port <n>           Hermes webhook port (default 8644)
      --hermes-dir <dir>   Hermes config+skills root (default ~/.hermes)
      --skip-daemon        do not install/start the ours daemon
      --skip-watcher       do not start the reactivity watcher
  -h, --help               show this help

Idempotent: safe to re-run. After it finishes, run /reload-mcp in Hermes.`);
}

if (!existsSync(INSTALL)) {
  console.error(`ours-hermes-install: cannot find install.sh at ${INSTALL}`);
  process.exit(1);
}

// install.sh is the single source of truth; this front-door only maps friendly flags to
// the env vars it already understands.
const env = { ...process.env };
if (opts.identities != null) env.CONNECTOR_IDENTITIES = opts.identities;
if (opts.port) env.OURS_WEBHOOK_PORT = opts.port;
if (opts.hermesDir) env.HERMES_DIR = opts.hermesDir;
if (opts.skipDaemon) env.OURS_INSTALL_SKIP_DAEMON = '1';
if (opts.skipWatcher) env.OURS_INSTALL_SKIP_WATCHER = '1';

const res = spawnSync('bash', [INSTALL], { stdio: 'inherit', env });
if (res.error) { console.error(`ours-hermes-install: ${res.error.message}`); process.exit(1); }
process.exit(res.status ?? 0);
