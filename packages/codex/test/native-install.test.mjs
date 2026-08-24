import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backupLegacySkill } from '../bin/codex-legacy-cleanup.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const install = join(root, 'install.sh');

function fixture(failAdd = false, orphanedMarker = false) {
  const dir = mkdtempSync(join(tmpdir(), 'ours-native-install-'));
  const bin = join(dir, 'bin'); const codex = join(dir, '.codex'); const skills = join(dir, '.agents/skills');
  mkdirSync(bin, { recursive: true }); mkdirSync(skills, { recursive: true }); mkdirSync(codex, { recursive: true });
  const fake = `#!/usr/bin/env bash\necho "$*" >> "${dir}/codex.log"\ncase "$*" in *"plugin add"*) exit ${failAdd ? 1 : 0};; esac\nexit 0\n`;
  writeFileSync(join(bin, 'codex'), fake); chmodSync(join(bin, 'codex'), 0o755);
  writeFileSync(join(codex, 'config.toml'), orphanedMarker
    ? 'before\n[mcp_servers.ours]\ncommand="ours-mcp"\n[mcp_servers.ours.tools.get_messages]\napproval_mode="approve"\n[mcp_servers.keep]\ncommand="keep"\n# <<< ours.network plugin\nafter\n'
    : 'before\n# >>> ours.network plugin\n[mcp_servers.ours]\ncommand="ours-mcp"\n# <<< ours.network plugin\nafter\n');
  writeFileSync(join(codex, 'AGENTS.md'), 'keep\n<!-- >>> ours.network plugin (managed block) -->\nold\n<!-- <<< ours.network plugin -->\n');
  for (const name of ['ours', 'writing-agent-bios']) { mkdirSync(join(skills, name), { recursive: true }); writeFileSync(join(skills, name, 'SKILL.md'), 'legacy'); }
  return { dir, bin, codex, skills };
}

function env(f) { return { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, CODEX_DIR: f.codex, SKILLS_DIR: f.skills, OURS_INSTALL_SKIP_DAEMON: '1' }; }

test('native plugin verifies first, then backs up and removes only legacy managed wiring', () => {
  const f = fixture();
  try {
    const out = execFileSync('bash', [install], { env: env(f), encoding: 'utf8' });
    const log = readFileSync(join(f.dir, 'codex.log'), 'utf8');
    assert.match(log, /plugin marketplace add adapt-toolkit\/ours-codex-marketplace/);
    assert.match(log, /plugin add ours@ours-codex-marketplace/);
    assert.doesNotMatch(readFileSync(join(f.codex, 'config.toml'), 'utf8'), /mcp_servers\.ours/);
    assert.match(readFileSync(join(f.codex, 'config.toml'), 'utf8'), /before.*after/s);
    assert.ok(readdirSync(f.codex).some((name) => name.startsWith('config.toml.ours-backup-')));
    assert.ok(readdirSync(f.skills).some((name) => name.startsWith('ours.ours-legacy-')));
    assert.match(out, /live mode:\s+ours-codex/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('plugin failure preserves all legacy wiring', () => {
  const f = fixture(true);
  try {
    const result = spawnSync('bash', [install], { env: env(f), encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(readFileSync(join(f.codex, 'config.toml'), 'utf8'), /mcp_servers\.ours/);
    assert.ok(existsSync(join(f.skills, 'ours/SKILL.md')));
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('legacy skill backup failure preserves the source and surfaces the error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ours-legacy-backup-'));
  const source = join(dir, 'ours');
  mkdirSync(source);
  writeFileSync(join(source, 'SKILL.md'), 'keep me');
  try {
    assert.throws(
      () => backupLegacySkill(source, `${source}.backup`, () => { throw new Error('injected rename failure'); }),
      /injected rename failure/,
    );
    assert.equal(readFileSync(join(source, 'SKILL.md'), 'utf8'), 'keep me');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('orphaned closing marker removes only old ours MCP tables', () => {
  const f = fixture(false, true);
  try {
    execFileSync('bash', [install], { env: env(f), encoding: 'utf8' });
    const config = readFileSync(join(f.codex, 'config.toml'), 'utf8');
    assert.doesNotMatch(config, /mcp_servers\.ours/);
    assert.doesNotMatch(config, /<<< ours\.network plugin/);
    assert.match(config, /\[mcp_servers\.keep\]\ncommand="keep"/);
    assert.match(config, /before.*after/s);
    assert.ok(readdirSync(f.codex).some((name) => name.startsWith('config.toml.ours-backup-')));
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
