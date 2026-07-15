// Integration test for install.sh in a sandbox CODEX_DIR + SKILLS_DIR (no daemon).
// Verifies: the ours + writing-agent-bios skills are installed, config.toml gets the
// [mcp_servers.ours] table, AGENTS.md gets the ours pointer, and a second run is a
// no-op that neither duplicates the MCP table nor the pointer (idempotent).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));
const INSTALL = join(PKG, 'install.sh');

function run(codexDir, skillsDir) {
  return execFileSync('bash', [INSTALL], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CODEX_DIR: codexDir,
      SKILLS_DIR: skillsDir,
      OURS_INSTALL_SKIP_DAEMON: '1',
      OURS_CODEX_SKIP_NATIVE: '1',
    },
  });
}

test('install.sh sets up skills, config.toml, and AGENTS.md; second run is idempotent', () => {
  const CODEX = mkdtempSync(join(tmpdir(), 'codex-'));
  const SKILLS = mkdtempSync(join(tmpdir(), 'codex-skills-'));
  try {
    run(CODEX, SKILLS);

    // skills installed under the USER-scope skills dir
    assert.ok(existsSync(join(SKILLS, 'ours/SKILL.md')), 'ours skill installed');
    assert.ok(existsSync(join(SKILLS, 'writing-agent-bios/SKILL.md')), 'bios skill installed');

    // config.toml has the managed block with the ours MCP server table
    const cfg = readFileSync(join(CODEX, 'config.toml'), 'utf8');
    assert.match(cfg, /# >>> ours\.network plugin/, 'managed sentinel present');
    assert.match(cfg, /\[mcp_servers\.ours\]/, '[mcp_servers.ours] table present');
    assert.match(cfg, /command = "ours-mcp"/, 'ours MCP server command present');
    assert.match(cfg, /args = \["proxy"\]/, 'ours MCP server args present');

    // AGENTS.md has the pointer block
    const agents = readFileSync(join(CODEX, 'AGENTS.md'), 'utf8');
    assert.match(agents, /ours\.network plugin \(managed block\)/, 'AGENTS pointer sentinel present');
    assert.match(agents, /get_messages/, 'AGENTS pointer mentions get_messages');
    assert.match(agents, /in-session/i, 'AGENTS pointer describes in-session reactivity');

    // second run: idempotent — one MCP table, one pointer
    run(CODEX, SKILLS);
    const cfg2 = readFileSync(join(CODEX, 'config.toml'), 'utf8');
    assert.equal((cfg2.match(/\[mcp_servers\.ours\]/g) || []).length, 1, 'MCP table not duplicated');
    assert.equal((cfg2.match(/# >>> ours\.network plugin/g) || []).length, 1, 'config block not duplicated');
    const agents2 = readFileSync(join(CODEX, 'AGENTS.md'), 'utf8');
    assert.equal(
      (agents2.match(/ours\.network plugin \(managed block\)/g) || []).length,
      1,
      'AGENTS pointer not duplicated',
    );
  } finally {
    rmSync(CODEX, { recursive: true, force: true });
    rmSync(SKILLS, { recursive: true, force: true });
  }
});
