#!/usr/bin/env node
// Friendly front-door for `npm i -g @ours.network/hermes` — the second of the two
// install commands:
//
//     npm i -g @ours.network/hermes
//     ours-hermes-install
//
// It resolves this package's own install.sh (which ensures the ours daemon, registers the
// `ours` MCP server in ~/.hermes/config.yaml, and installs the skills) and runs it — no env-var
// gymnastics. The MCP server + skill install immediately. Wake-on-mail is NOT set up here: the
// agent enables it in-session by tailing `ours-mcp watch <identity>` (see the ours skill),
// exactly like Claude Code. Everything is idempotent, so re-running is safe.
//
// Usage:
//   ours-hermes-install [--hermes-dir DIR] [--skip-daemon]
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
  if (a === '--hermes-dir') opts.hermesDir = argv[++i];
  else if (a === '--skip-daemon') opts.skipDaemon = true;
  else if (a === '--help' || a === '-h') { help(); process.exit(0); }
  else { console.error(`ours-hermes-install: unknown argument "${a}"`); help(); process.exit(2); }
}

function help() {
  console.log(`ours-hermes-install — set up the ours.network plugin for Hermes.

  ours-hermes-install [options]

Sets up the daemon + the ours MCP server + the skill. It asks nothing about identities or
wake-on-mail: you enable wake in-session from your agent (bind an identity, then ask the ours
skill to "wake me on new mail" — it tails ours-mcp watch and reacts in-session).

Options:
      --hermes-dir <dir>   Hermes config+skills root (default ~/.hermes)
      --skip-daemon        do not install/start the ours daemon
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
if (opts.hermesDir) env.HERMES_DIR = opts.hermesDir;
if (opts.skipDaemon) env.OURS_INSTALL_SKIP_DAEMON = '1';

const res = spawnSync('bash', [INSTALL], { stdio: 'inherit', env });
if (res.error) { console.error(`ours-hermes-install: ${res.error.message}`); process.exit(1); }
process.exit(res.status ?? 0);
