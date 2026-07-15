#!/usr/bin/env node
// Friendly front-door for `npm i -g @ours.network/codex` — the second of the two
// install commands:
//
//     npm i -g @ours.network/codex
//     ours-codex-install
//
// SUPERSEDED BY `ours-install`: the unified `ours-install` is now the single front door for the
// WHOLE stack (ours core + harness plugins + ours-fleet + Telegram). `ours-codex-install` is kept
// as a THIN ALIAS — by default it hands off to `ours-install` when that's available, so an old
// muscle-memory command still lands the user in the current, unified flow. Pass `--codex-only`
// (or set OURS_CODEX_LEGACY=1) to force the legacy Codex-only install below.
//
// Usage:
//   ours-codex-install [--codex-only] [--codex-dir DIR] [--skills-dir DIR] [--skip-daemon]
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

// Thin-alias hand-off: unless the caller forced the legacy Codex-only path, run the unified
// `ours-install` if we can find it — on PATH (published), or the monorepo sibling (dev/test).
if (!opts.codexOnly && !process.env.OURS_CODEX_LEGACY) {
  const onPath = spawnSync('bash', ['-c', 'command -v ours-install'], { encoding: 'utf8' });
  const unified = (onPath.status === 0 && (onPath.stdout || '').trim())
    ? { cmd: (onPath.stdout || '').trim(), args: argv }
    : (() => {
        const sib = join(PKG, '..', 'installer', 'install.mjs');
        return existsSync(sib) ? { cmd: process.execPath, args: [sib, ...argv] } : null;
      })();
  if (unified) {
    const r = spawnSync(unified.cmd, unified.args, { stdio: 'inherit', env: process.env });
    if (r.error) { console.error(`ours-codex-install: ${r.error.message}`); process.exit(1); }
    process.exit(r.status ?? 0);
  }
  // No unified installer found → fall through to the legacy Codex-only install (still never a dead end).
}

function help() {
  console.log(`ours-codex-install — set up the ours.network plugin for the OpenAI Codex CLI.

  ours-codex-install [options]

By default this hands off to the unified \`ours-install\` (the single front door for the whole
stack). Use --codex-only to run the legacy Codex-only install instead. Standard mode uses
\`codex\`; live mode uses \`ours-codex\`. Live monitoring still requires explicit consent.

Options:
      --codex-only          run the legacy Codex-only install (skip the unified ours-install)
      --codex-dir <dir>     Codex config+AGENTS.md root (default ~/.codex)     [--codex-only]
      --skills-dir <dir>    skills root (default ~/.agents/skills — USER scope) [--codex-only]
      --skip-daemon         do not install/start the ours daemon               [--codex-only]
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
