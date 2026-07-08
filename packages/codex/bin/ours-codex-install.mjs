#!/usr/bin/env node
// Friendly front-door for `npm i -g @ours.network/codex` — the second of the two
// install commands:
//
//     npm i -g @ours.network/codex
//     ours-codex-install
//
// It resolves this package's own install.sh (which ensures the ours daemon, registers
// the `ours` MCP server in ~/.codex/config.toml, installs the skills into
// ~/.agents/skills, and points ~/.codex/AGENTS.md at the ours skill) and runs it — no
// env-var gymnastics. The MCP server + skill install immediately; they are live for the
// next Codex session.
//
// Wake-on-mail is NOT set up here: the agent tails `ours-mcp watch <identity>` (or a short
// get_messages poll) IN-SESSION (see the ours skill), the same stream Claude Code's Monitor
// tails. Codex is a session/invocation CLI, so it reacts while it is live. Everything is
// idempotent, so re-running is safe.
//
// Usage:
//   ours-codex-install [--codex-dir DIR] [--skills-dir DIR] [--skip-daemon]
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
  if (a === '--codex-dir') opts.codexDir = argv[++i];
  else if (a === '--skills-dir') opts.skillsDir = argv[++i];
  else if (a === '--skip-daemon') opts.skipDaemon = true;
  else if (a === '--help' || a === '-h') { help(); process.exit(0); }
  else { console.error(`ours-codex-install: unknown argument "${a}"`); help(); process.exit(2); }
}

function help() {
  console.log(`ours-codex-install — set up the ours.network plugin for the OpenAI Codex CLI.

  ours-codex-install [options]

Sets up the daemon + the ours MCP server + the skill + the AGENTS.md pointer. It asks nothing
about identities or wake-on-mail: you enable wake in-session (bind an identity, then the ours
skill tails ours-mcp watch / polls get_messages so you react to new mail while you work).

Options:
      --codex-dir <dir>     Codex config+AGENTS.md root (default ~/.codex)
      --skills-dir <dir>    skills root (default ~/.agents/skills — USER scope)
      --skip-daemon         do not install/start the ours daemon
  -h, --help                show this help

Idempotent: safe to re-run. MCP server + skill are live for the next Codex session.`);
}

if (!existsSync(INSTALL)) {
  console.error(`ours-codex-install: cannot find install.sh at ${INSTALL}`);
  process.exit(1);
}

// install.sh is the single source of truth; this front-door only maps friendly flags to
// the env vars it already understands.
const env = { ...process.env };
if (opts.codexDir) env.CODEX_DIR = opts.codexDir;
if (opts.skillsDir) env.SKILLS_DIR = opts.skillsDir;
if (opts.skipDaemon) env.OURS_INSTALL_SKIP_DAEMON = '1';

const res = spawnSync('bash', [INSTALL], { stdio: 'inherit', env });
if (res.error) { console.error(`ours-codex-install: ${res.error.message}`); process.exit(1); }
process.exit(res.status ?? 0);
