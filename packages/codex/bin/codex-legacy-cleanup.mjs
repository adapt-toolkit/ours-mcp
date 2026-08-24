#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, renameSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

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

function stripOrphanedMcpConfig(path) {
  if (!existsSync(path)) return false;
  const before = readFileSync(path, 'utf8');
  const end = '# <<< ours.network plugin';
  if (!before.includes(end) || before.includes('# >>> ours.network plugin') || !/^\s*\[mcp_servers\.ours(?:\.[^\]]+)?\]/m.test(before)) return false;

  const kept = [];
  let dropping = false;
  for (const line of before.split('\n')) {
    if (/^\s*\[mcp_servers\.ours(?:\.[^\]]+)?\]\s*(?:#.*)?$/.test(line)) {
      dropping = true;
      continue;
    }
    if (dropping && /^\s*\[[^\]]+\]/.test(line)) dropping = false;
    if (!dropping && line.trim() !== end) kept.push(line);
  }

  const after = kept.join('\n').replace(/^\s+$/, '');
  if (after === before) return false;
  writeFileSync(`${path}.ours-backup-${stamp}`, before, { mode: 0o600 });
  writeFileSync(path, after);
  return true;
}

export function backupLegacySkill(path, backup, rename = renameSync) {
  if (!existsSync(path)) return false;
  rename(path, backup);
  return true;
}

function main() {
  const configPath = join(codexDir, 'config.toml');
  if (!stripManaged(configPath, '# >>> ours.network plugin', '# <<< ours.network plugin')) stripOrphanedMcpConfig(configPath);
  stripManaged(join(codexDir, 'AGENTS.md'), '<!-- >>> ours.network plugin', '<!-- <<< ours.network plugin -->');

  for (const name of ['ours', 'writing-agent-bios']) {
    const path = join(skillsDir, name);
    backupLegacySkill(path, `${path}.ours-legacy-${stamp}`);
  }
}

const invokedDirectly = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) main();
