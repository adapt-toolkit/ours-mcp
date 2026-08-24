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

function run(hermesDir) {
  return execFileSync('bash', [INSTALL], {
    encoding: 'utf8',
    env: { ...process.env, HERMES_DIR: hermesDir, OURS_INSTALL_SKIP_DAEMON: '1' },
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

    // second run: idempotent — exactly one sentinel block
    run(H);
    const cfg2 = readFileSync(join(H, 'config.yaml'), 'utf8');
    assert.equal((cfg2.match(/# >>> ours\.network plugin/g) || []).length, 1, 'block not duplicated');
  } finally {
    rmSync(H, { recursive: true, force: true });
  }
});

test('install.sh fails when a stopped daemon cannot be started', () => {
  const root = mkdtempSync(join(tmpdir(), 'hermes-daemon-failure-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'npm'), '#!/usr/bin/env bash\nexit 0\n');
  writeFileSync(join(bin, 'ours'), `#!/usr/bin/env bash
case "$*" in
  version) echo 1.0.0 ;;
  "daemon status"|"daemon start") exit 1 ;;
esac
`);
  writeFileSync(join(bin, 'ours-mcp'), '#!/usr/bin/env bash\nexit 0\n');
  for (const name of ['npm', 'ours', 'ours-mcp']) chmodSync(join(bin, name), 0o755);
  try {
    const result = spawnSync('bash', [INSTALL], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HERMES_DIR: join(root, '.hermes') },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /could not start the ours daemon/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
