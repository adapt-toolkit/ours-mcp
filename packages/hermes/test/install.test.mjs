// Integration test for install.sh in a sandbox HERMES_DIR (no daemon).
// Verifies: skills are installed, config.yaml gets the ours MCP server block, there is NO
// webhook/route/secret/connector-env (reactivity is in-session `ours-mcp watch`), and a second
// run is a no-op that does not duplicate the block (idempotent).
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
  writeFileSync(join(bin, 'ours'), `#!/usr/bin/env bash
echo "$*" >> "${root}/client-calls"
[ "$*" = "config show --json" ] && exit ${valid ? 0 : 1}
exit 99
`);
  writeFileSync(join(bin, 'ours-mcp'), '#!/usr/bin/env bash\nexit 0\n');
  writeFileSync(join(bin, 'npm'), `#!/usr/bin/env bash\ntouch "${root}/unexpected-npm"\nexit 99\n`);
  for (const n of ['ours','ours-mcp','npm']) chmodSync(join(bin,n),0o755);
  return `${bin}:${process.env.PATH}`;
}

function run(hermesDir) {
  return execFileSync('bash', [INSTALL], {
    encoding: 'utf8',
    env: { ...process.env, HERMES_DIR: hermesDir, PATH: clientBin(hermesDir) },
  });
}

test('install.sh sets up skills + the ours MCP server (no route/secret); second run is idempotent', () => {
  const H = mkdtempSync(join(tmpdir(), 'hermes-'));
  try {
    run(H);

    // skills installed under the Hermes category layout
    assert.ok(existsSync(join(H, 'skills/communication/ours/SKILL.md')), 'ours skill installed');
    assert.ok(existsSync(join(H, 'skills/communication/writing-agent-bios/SKILL.md')), 'bios skill installed');

    // config.yaml has the managed block with the ours MCP server, and NOTHING wake-related
    const cfg = readFileSync(join(H, 'config.yaml'), 'utf8');
    assert.match(cfg, /# >>> ours\.network plugin/, 'managed sentinel present');
    assert.match(cfg, /command: "ours-mcp"/, 'ours MCP server present');
    assert.doesNotMatch(cfg, /ours-wake|platforms:|webhook|secret:/, 'no webhook/route/secret');

    // the connector approach is gone: no connector env file is written
    assert.ok(!existsSync(join(H, 'ours-connector.env')), 'no connector env file');

    assert(!existsSync(join(H, 'unexpected-npm')));
    assert.equal(readFileSync(join(H, 'client-calls'),'utf8').trim(), 'config show --json');

    // second run: idempotent — exactly one sentinel block
    run(H);
    const cfg2 = readFileSync(join(H, 'config.yaml'), 'utf8');
    assert.equal((cfg2.match(/# >>> ours\.network plugin/g) || []).length, 1, 'block not duplicated');
  } finally {
    rmSync(H, { recursive: true, force: true });
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
    assert.equal(readFileSync(join(root,'client-calls'),'utf8').trim(),'config show --json');
    assert(!existsSync(join(root,'plugin')));
    assert(!existsSync(join(root,'unexpected-npm')));
  } finally { rmSync(root,{recursive:true,force:true}); }
});
