#!/usr/bin/env node
// ours.network — the Node uninstaller (the real UX behind uninstall.sh's thin bootstrap). The
// symmetric partner to install.mjs: same banner + colours + plain-language explanations, but for
// REMOVAL. It removes ONLY what the ours installers created — sentinel-delimited config blocks,
// the ours skill dirs, the npm globals, plus cleanup of any LEGACY connector env/log leftovers —
// never unrelated files. The two destructive items (data dir, daemon) require an explicit typed
// 'yes'. Everything uses safe, quoted, explicit paths — no wildcards on $HOME.
//
// Non-interactive env overrides (all optional):
//   OURS_UNINSTALL="hermes codex"   which harness plugins to remove (space/comma; names or "all")
//   OURS_UNINSTALL_DATA=yes         also remove the ours data dir (~/.ours) [destructive]
//   OURS_UNINSTALL_DAEMON=yes       also stop + remove the ours-mcp daemon + its service
//   OURS_ASSUME_YES=1               accept defaults; skip the typed confirmations (implies no tty)
//   OURS_NPM="npm"                  npm binary to use
//   HERMES_DIR / CODEX_DIR / SKILLS_DIR / OURS_STATE_DIR   path overrides
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { banner, heading, c, openTty, makeWriter, closeSync } from './lib/ui.mjs';
import { askLine, checkboxSelect } from './lib/prompt.mjs';
import { canonHarnesses } from './lib/logic.mjs';

const NPM = process.env.OURS_NPM || 'npm';
const HOME = homedir();
const HERMES_DIR = process.env.HERMES_DIR || join(HOME, '.hermes');
const CODEX_DIR = process.env.CODEX_DIR || join(HOME, '.codex');
const SKILLS_DIR = process.env.SKILLS_DIR || join(HOME, '.agents', 'skills');
const OURS_STATE_DIR = process.env.OURS_STATE_DIR || join(HOME, '.ours');
const ASSUME_YES = !!process.env.OURS_ASSUME_YES;

const say = (s) => process.stdout.write(`ours: ${s}\n`);
const line = (s = '') => process.stdout.write(`${s}\n`);

// Sentinel markers stamped by the installers' config helpers (must match them verbatim).
const YAML_START = '# >>> ours.network plugin (managed block)';
const YAML_END = '# <<< ours.network plugin';
const MD_START = '<!-- >>> ours.network plugin (managed block) -->';
const MD_END = '<!-- <<< ours.network plugin -->';

const run = (bin, args) => spawnSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// --- safe removal helpers ----------------------------------------------------------------------
function rmDir(d) { if (d && existsSync(d)) { rmSync(d, { recursive: true, force: true }); say(`  removed ${d}`); } }
function rmFile(f) { if (f && existsSync(f)) { rmSync(f, { force: true }); say(`  removed ${f}`); } }

// stripBlock: delete the sentinel-delimited managed block (inclusive) if present; leave the file
// untouched otherwise. Only ever removes OUR block.
function stripBlock(file, start, end) {
  if (!existsSync(file)) return;
  const text = readFileSync(file, 'utf8');
  if (!text.includes(start)) return;
  const lines = text.split('\n');
  const out = [];
  let skip = false;
  for (const ln of lines) {
    if (!skip && ln.includes(start)) { skip = true; continue; }
    if (skip) { if (ln.includes(end)) skip = false; continue; }
    out.push(ln);
  }
  writeFileSync(file, out.join('\n'));
  say(`  removed the ours managed block from ${file}`);
}

function npmRm(pkg) {
  const r = run(NPM, ['rm', '-g', pkg]);
  if (r.status === 0) say(`  npm: removed ${pkg}`);
  else say(`  npm: ${pkg} not installed globally (skipped)`);
}

// --- per-harness removal -----------------------------------------------------------------------
function removeHermes() {
  line(heading('→ removing hermes plugin'));
  stripBlock(join(HERMES_DIR, 'config.yaml'), YAML_START, YAML_END);
  rmDir(join(HERMES_DIR, 'skills', 'communication', 'ours'));
  rmDir(join(HERMES_DIR, 'skills', 'communication', 'writing-agent-bios'));
  rmFile(join(HERMES_DIR, 'ours-connector.env'));
  rmFile(join(HERMES_DIR, 'ours-connector.log'));
  npmRm('@ours.network/hermes');
}

function removeCodex() {
  line(heading('→ removing codex plugin'));
  stripBlock(join(CODEX_DIR, 'config.toml'), YAML_START, YAML_END);
  stripBlock(join(CODEX_DIR, 'AGENTS.md'), MD_START, MD_END);
  rmDir(join(SKILLS_DIR, 'ours'));
  rmDir(join(SKILLS_DIR, 'writing-agent-bios'));
  npmRm('@ours.network/codex');
}

function removeClaudeCode() {
  line(heading('→ claude-code'));
  say("Claude Code's plugin lives in its in-app marketplace — the uninstaller can't remove it.");
  say('Inside your Claude Code session, run:');
  line('');
  line('    /plugin uninstall ours.network');
  line('    /plugin marketplace remove adapt-toolkit/ours-claude-marketplace');
  line('');
}

// Typed-'yes' gate for destructive removals. assume-yes bypasses; no-tty (without assume-yes)
// declines rather than guesses.
function confirmDestructive(write, fd, what) {
  if (ASSUME_YES) return true;
  if (fd == null) return false;
  return askLine(write, fd, `  Type 'yes' to permanently remove ${what}: `, 'no') === 'yes';
}

// ===============================================================================================
function main() {
  const ttyFd = openTty();
  const write = makeWriter(ttyFd);

  line(banner());
  line(c.bold('  ours.network uninstaller'));
  say('Removes only what the ours installers created. Nothing is removed until you confirm.');

  // --- 1) choose what to remove ----------------------------------------------------------------
  let selected = [];
  let wantData = false;
  let wantDaemon = false;

  const envUninstall = process.env.OURS_UNINSTALL;
  if (envUninstall != null || process.env.OURS_UNINSTALL_DATA || process.env.OURS_UNINSTALL_DAEMON) {
    selected = canonHarnesses(envUninstall || '').names;
    wantData = process.env.OURS_UNINSTALL_DATA === 'yes';
    wantDaemon = process.env.OURS_UNINSTALL_DAEMON === 'yes';
  } else if (ttyFd != null) {
    line(heading('1) what to remove'));
    const picked = checkboxSelect(write, ttyFd, [
      { name: 'claude-code', label: 'Claude Code plugin (prints manual removal commands)' },
      { name: 'codex', label: 'Codex plugin' },
      { name: 'hermes', label: 'Hermes plugin' },
      { name: 'data', label: `ours data directory (${OURS_STATE_DIR} — identities + keys) [destructive]` },
      { name: 'daemon', label: 'ours-mcp daemon (stop + remove service + npm global) [destructive]' },
    ], { title: `Choose what to remove — ${c.bold('↑/↓')} move, ${c.bold('Space')} toggle, ${c.bold('Enter')} confirm (a=all, n=none)` });
    wantData = picked.includes('data');
    wantDaemon = picked.includes('daemon');
    selected = canonHarnesses(picked.filter((p) => p !== 'data' && p !== 'daemon').join(' ')).names;
  } else {
    say('no terminal and no OURS_UNINSTALL* set — nothing to do. Re-run with a terminal, or set');
    say('  OURS_UNINSTALL="hermes codex" [OURS_UNINSTALL_DATA=yes] [OURS_UNINSTALL_DAEMON=yes]');
    finish(ttyFd);
    return;
  }

  if (selected.length === 0 && !wantData && !wantDaemon) {
    line(heading('Done'));
    say('Nothing selected — nothing removed.');
    finish(ttyFd);
    return;
  }

  // --- 2) remove selected harness plugins ------------------------------------------------------
  const removed = [];
  let killWatcher = false;
  for (const h of selected) {
    if (h === 'hermes') { removeHermes(); killWatcher = true; removed.push('hermes'); }
    else if (h === 'codex') { removeCodex(); removed.push('codex'); }
    else if (h === 'claude-code') { removeClaudeCode(); removed.push('claude-code'); }
  }
  // Stop any reactivity watcher we started (only when a reactive harness was removed).
  if (killWatcher) { if (run('pkill', ['-f', 'connector-watch.sh']).status === 0) say('stopped the ours reactivity watcher(s).'); }

  // --- 3) data directory (destructive, guarded) ------------------------------------------------
  if (wantData) {
    line(heading('→ ours data directory'));
    say(`This holds your ours IDENTITIES and private KEYS (${OURS_STATE_DIR}). Removing it is`);
    say('permanent and cannot be undone — you would lose those identities.');
    if (confirmDestructive(write, ttyFd, `the ours data directory (${OURS_STATE_DIR})`)) { rmDir(OURS_STATE_DIR); removed.push('data-dir'); }
    else say('  kept the data directory.');
  }

  // --- 4) daemon (destructive, guarded) --------------------------------------------------------
  if (wantDaemon) {
    line(heading('→ ours-mcp daemon'));
    if (confirmDestructive(write, ttyFd, 'the ours-mcp daemon (stops it + removes its service + npm global)')) {
      if (run('sh', ['-c', 'command -v ours-mcp']).status === 0) {
        run('ours-mcp', ['stop']); say('  stopped the daemon (if it was running).');
        run('ours-mcp', ['uninstall-service']); say('  removed the persistent service (if present).');
      }
      npmRm('@ours.network/mcp');
      removed.push('daemon');
    } else say('  kept the daemon.');
  }

  // --- done ------------------------------------------------------------------------------------
  line(heading('Done'));
  if (removed.length) { say('removed:'); for (const r of removed) say(`  ${c.green('✓')} ${r}`); }
  else say('nothing was removed.');
  if (!wantData) say(`Your ours identities/keys in ${OURS_STATE_DIR} were left in place.`);
  say("Reload each harness to drop the ours tools (Hermes: '/reload-mcp'; Codex: next session).");
  finish(ttyFd);
}

function finish(ttyFd) { if (ttyFd != null) { try { closeSync(ttyFd); } catch { /* ignore */ } } }

main();
