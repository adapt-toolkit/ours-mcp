// Integration test for install.sh in a sandbox CODEX_DIR + SKILLS_DIR (no daemon).
// Verifies: the ours + writing-agent-bios skills are installed, config.toml gets the
// [mcp_servers.ours] table, AGENTS.md gets the ours pointer, and a second run is a
// no-op that neither duplicates the MCP table nor the pointer (idempotent).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));
const INSTALL = join(PKG, 'install.sh');

function clientBin(root, valid = true) {
  const bin = join(root, 'bin'); mkdirSync(bin, {recursive:true});
  // A legacy CLI returning successful local config cannot satisfy the new contract.
  writeFileSync(join(bin, 'ours'), `#!/usr/bin/env bash\necho '{"selection":{"stateDir":"legacy"}}'\nexit 0\n`);
  writeFileSync(join(bin, 'ours-mcp'), `#!/usr/bin/env bash
echo "$*" >> "${root}/client-calls"
echo '${valid ? 'ours.gateway-client-profile-v1' : '{"selection":{"stateDir":"legacy"}}'}'
exit 0
`);
  writeFileSync(join(bin, 'npm'), `#!/usr/bin/env bash\ntouch "${root}/unexpected-npm"\nexit 99\n`);
  for (const n of ['ours','ours-mcp','npm']) chmodSync(join(bin,n),0o755);
  return `${bin}:${process.env.PATH}`;
}

function run(codexDir, skillsDir) {
  return execFileSync('bash', [INSTALL], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CODEX_DIR: codexDir,
      SKILLS_DIR: skillsDir,
      PATH: clientBin(codexDir),
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

    assert(!existsSync(join(CODEX, 'unexpected-npm')));
    assert.equal(readFileSync(join(CODEX, 'client-calls'),'utf8').trim(), 'verify-client-profile');

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

test('install.sh refuses an invalid shared profile before plugin or server mutations', () => {
  const root = mkdtempSync(join(tmpdir(), 'gateway-install-refusal-'));
  try {
    const result = spawnSync('bash', [INSTALL], { encoding:'utf8', env:{
      ...process.env, PATH:clientBin(root,false), CODEX_DIR:join(root,'plugin'),
      HERMES_DIR:join(root,'plugin'), SKILLS_DIR:join(root,'skills'), OURS_INSTALL_SKIP_DAEMON:'1',
    }});
    assert.notEqual(result.status,0);
    assert.match(result.stdout,/shared gateway profile/);
    assert.equal(readFileSync(join(root,'client-calls'),'utf8').trim(),'verify-client-profile');
    assert(!existsSync(join(root,'plugin')));
    assert(!existsSync(join(root,'unexpected-npm')));
  } finally { rmSync(root,{recursive:true,force:true}); }
});
