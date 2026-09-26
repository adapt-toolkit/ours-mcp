#!/usr/bin/env node
// Friendly front-door for `npm i -g @ours.network/codex` — the second of the two
// install commands:
//
//     npm i -g @ours.network/codex
//     ours-codex-install
//
// Installs client plugin wiring only after shared gateway profile validation.
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
  else if (a === '--codex-only' || a === '--legacy') opts.codexOnly = true;
  else if (a === '--help' || a === '-h') { help(); process.exit(0); }
  else { console.error(`ours-codex-install: unknown argument "${a}"`); help(); process.exit(2); }
}

function help() {
  console.log(`ours-codex-install — set up the ours.network plugin for the OpenAI Codex CLI.

  ours-codex-install [options]

Requires clients and a shared gateway profile provisioned by \`ours-install client\`. Standard mode uses
\`codex\`; live mode uses \`ours-codex\`. Live monitoring still requires explicit consent.

Options:
      --codex-only          compatibility flag; plugin setup is always client-only
      --codex-dir <dir>     Codex config+AGENTS.md root (default ~/.codex)     [--codex-only]
      --skills-dir <dir>    skills root (default ~/.agents/skills — USER scope) [--codex-only]
      --skip-daemon         compatibility flag; server lifecycle is never changed               [--codex-only]
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

const res = spawnSync('bash', [INSTALL], { stdio: 'inherit', env });
if (res.error) { console.error(`ours-codex-install: ${res.error.message}`); process.exit(1); }
process.exit(res.status ?? 0);
