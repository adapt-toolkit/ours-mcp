// Integration test for install.sh in a sandbox HERMES_DIR (no daemon, no watcher).
// Verifies: skills are installed, config.yaml gets the ours-wake route with a real
// generated secret, an env file records that same secret, and a second run is a
// no-op that neither duplicates the block nor rotates the secret (idempotent).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));
const INSTALL = join(PKG, 'install.sh');

function run(hermesDir) {
  return execFileSync('bash', [INSTALL], {
    encoding: 'utf8',
    env: { ...process.env, HERMES_DIR: hermesDir, OURS_INSTALL_SKIP_DAEMON: '1', OURS_INSTALL_SKIP_WATCHER: '1' },
  });
}
const secretOf = (envText) => (envText.match(/CONNECTOR_HMAC_SECRET="([^"]+)"/) || [])[1];

test('install.sh sets up skills, config, and env; second run is idempotent', () => {
  const H = mkdtempSync(join(tmpdir(), 'hermes-'));
  try {
    run(H);

    // skills installed under the Hermes category layout
    assert.ok(existsSync(join(H, 'skills/communication/ours/SKILL.md')), 'ours skill installed');
    assert.ok(existsSync(join(H, 'skills/communication/writing-agent-bios/SKILL.md')), 'bios skill installed');

    // config.yaml has the managed block with the ours-wake route
    const cfg = readFileSync(join(H, 'config.yaml'), 'utf8');
    assert.match(cfg, /# >>> ours\.network plugin/, 'managed sentinel present');
    assert.match(cfg, /ours-wake:/, 'ours-wake route present');
    assert.match(cfg, /command: "ours-mcp"/, 'ours MCP server present');

    // a real (non-default) secret was generated and shared into route + env
    const env1 = readFileSync(join(H, 'ours-connector.env'), 'utf8');
    const secret = secretOf(env1);
    assert.ok(secret && secret !== 'CHANGE_ME_local_webhook_hmac', 'generated a real secret');
    assert.match(cfg, new RegExp(`secret: "${secret}"`), 'route secret matches the connector env secret');

    // second run: idempotent — one sentinel, same secret
    run(H);
    const cfg2 = readFileSync(join(H, 'config.yaml'), 'utf8');
    assert.equal((cfg2.match(/# >>> ours\.network plugin/g) || []).length, 1, 'block not duplicated');
    assert.equal(secretOf(readFileSync(join(H, 'ours-connector.env'), 'utf8')), secret, 'secret not rotated');
  } finally {
    rmSync(H, { recursive: true, force: true });
  }
});
