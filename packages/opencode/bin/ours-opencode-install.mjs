#!/usr/bin/env node
// Friendly front-door for `npm i -g @ours.network/opencode` — the second of the two
// install commands:
//
//     npm i -g @ours.network/opencode
//     ours-opencode-install
//
// It resolves this package's own install.sh (which ensures the ours daemon, registers the
// `ours` MCP server in ~/.config/opencode/opencode.json, and installs the skills) and runs
// it — no env-var gymnastics. Everything is idempotent, so re-running is safe.
//
// Usage:
//   ours-opencode-install [--opencode-dir DIR] [--skip-daemon]
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
  if (a === '--opencode-dir') opts.opencodeDir = argv[++i];
  else if (a === '--skip-daemon') opts.skipDaemon = true;
  else if (a === '--help' || a === '-h') { help(); process.exit(0); }
  else { console.error(`ours-opencode-install: unknown argument "${a}"`); help(); process.exit(2); }
}

function help() {
  console.log(`ours-opencode-install — set up the ours.network plugin for OpenCode.

  ours-opencode-install [options]

Sets up the daemon + the ours MCP server + the ours and writing-agent-bios skills. Wake-on-mail
is not configured here: enable it in-session from your agent (bind an identity, then ask the
ours skill to "wake me on new mail" — it tails ours-mcp watch and reacts in-session).

Options:
      --opencode-dir <dir>   OpenCode config+skills root (default ~/.config/opencode)
      --skip-daemon          do not install/start the ours daemon
  -h, --help                 show this help

Idempotent: safe to re-run. After it finishes, restart opencode.`);
}

if (!existsSync(INSTALL)) {
  console.error(`ours-opencode-install: cannot find install.sh at ${INSTALL}`);
  process.exit(1);
}

// install.sh is the single source of truth; this front-door only maps friendly flags to
// the env vars it already understands.
const env = { ...process.env };
if (opts.opencodeDir) env.OPENCODE_DIR = opts.opencodeDir;
if (opts.skipDaemon) env.OURS_INSTALL_SKIP_DAEMON = '1';

const res = spawnSync('bash', [INSTALL], { stdio: 'inherit', env });
if (res.error) { console.error(`ours-opencode-install: ${res.error.message}`); process.exit(1); }
process.exit(res.status ?? 0);
