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
// Reactivity is SESSION-ONLY by default (Codex has no background wake — the agent checks
// get_messages when it goes live / expects a reply). An OPTIONAL, non-native fallback
// drives Codex headlessly via `codex exec` from the shared connector gateway; enable it
// with --reactivity=codex-exec, which only PRINTS setup instructions (it does not start
// an always-on process). Everything is idempotent, so re-running is safe.
//
// Usage:
//   ours-codex-install [--reactivity none|codex-exec] [--identities "Agent1 Agent2"]
//                      [--codex-dir DIR] [--skills-dir DIR] [--skip-daemon] [--help]
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
  if (a === '--reactivity') opts.reactivity = argv[++i];
  else if (a.startsWith('--reactivity=')) opts.reactivity = a.slice('--reactivity='.length);
  else if (a === '--identities' || a === '-i') opts.identities = argv[++i];
  else if (a === '--codex-dir') opts.codexDir = argv[++i];
  else if (a === '--skills-dir') opts.skillsDir = argv[++i];
  else if (a === '--skip-daemon') opts.skipDaemon = true;
  else if (a === '--help' || a === '-h') { help(); process.exit(0); }
  else { console.error(`ours-codex-install: unknown argument "${a}"`); help(); process.exit(2); }
}

function help() {
  console.log(`ours-codex-install — set up the ours.network plugin for the OpenAI Codex CLI.

  ours-codex-install [options]

Options:
      --reactivity <mode>   none (default, session-only) | codex-exec (optional,
                            non-native fallback — prints connector+codex-exec setup)
  -i, --identities "A B"    ours identities the optional codex-exec gateway would drive
      --codex-dir <dir>     Codex config+AGENTS.md root (default ~/.codex)
      --skills-dir <dir>    skills root (default ~/.agents/skills — USER scope)
      --skip-daemon         do not install/start the ours daemon
  -h, --help                show this help

Idempotent: safe to re-run. MCP server + skill are live for the next Codex session.
Reactivity is session-only unless you opt into the (flagged, non-native) codex-exec fallback.`);
}

if (!existsSync(INSTALL)) {
  console.error(`ours-codex-install: cannot find install.sh at ${INSTALL}`);
  process.exit(1);
}

// install.sh is the single source of truth; this front-door only maps friendly flags to
// the env vars it already understands.
const env = { ...process.env };
if (opts.reactivity != null) env.OURS_REACTIVITY = opts.reactivity;
if (opts.identities != null) env.CONNECTOR_IDENTITIES = opts.identities;
if (opts.codexDir) env.CODEX_DIR = opts.codexDir;
if (opts.skillsDir) env.SKILLS_DIR = opts.skillsDir;
if (opts.skipDaemon) env.OURS_INSTALL_SKIP_DAEMON = '1';

const res = spawnSync('bash', [INSTALL], { stdio: 'inherit', env });
if (res.error) { console.error(`ours-codex-install: ${res.error.message}`); process.exit(1); }
process.exit(res.status ?? 0);
