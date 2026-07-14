#!/usr/bin/env node
// Friendly front-door for `npm i -g @ours.network/codex` — the second of the two
// install commands:
//
//     npm i -g @ours.network/codex
//     ours-codex-install
//
// It resolves this package's install.sh, ensures the existing daemon installation,
// registers the native Codex marketplace/plugin, and migrates installer-owned legacy
// config only after Codex confirms the native plugin is installed.
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

Sets up the daemon and native ours Codex plugin. Standard mode uses `codex`; live mode uses
`ours-codex`. Live monitoring still requires explicit consent after an identity is bound.

Options:
      --codex-dir <dir>     Codex config+AGENTS.md root (default ~/.codex)
      --skills-dir <dir>    skills root (default ~/.agents/skills — USER scope)
      --skip-daemon         do not install/start the ours daemon
  -h, --help                show this help

Idempotent: safe to re-run. Start a new Codex thread after installation and review the
plugin's exact hook definitions before trusting them.`);
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
