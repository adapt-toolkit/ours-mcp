#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, renameSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';

const codexDir = resolve(process.env.CODEX_DIR || process.env.CODEX_HOME || join(homedir(), '.codex'));
const skillsDir = resolve(process.env.SKILLS_DIR || join(homedir(), '.agents', 'skills'));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

function stripManaged(path, start, end) {
  if (!existsSync(path)) return false;
  const before = readFileSync(path, 'utf8');
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const after = before.replace(new RegExp(`${escape(start)}[\\s\\S]*?${escape(end)}\\s*`, 'g'), '').replace(/^\s+$/, '');
  if (after === before) return false;
  writeFileSync(`${path}.ours-backup-${stamp}`, before, { mode: 0o600 });
  writeFileSync(path, after);
  return true;
}

stripManaged(join(codexDir, 'config.toml'), '# >>> ours.network plugin', '# <<< ours.network plugin');
stripManaged(join(codexDir, 'AGENTS.md'), '<!-- >>> ours.network plugin', '<!-- <<< ours.network plugin -->');

for (const name of ['ours', 'writing-agent-bios']) {
  const path = join(skillsDir, name);
  if (!existsSync(path)) continue;
  const backup = `${path}.ours-legacy-${stamp}`;
  try { renameSync(path, backup); } catch { rmSync(path, { recursive: true, force: true }); }
}
