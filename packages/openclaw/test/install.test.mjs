// Integration test for install.sh in a sandbox OPENCLAW_DIR (no daemon).
// Verifies: skills are installed, openclaw.json gets ONLY the ours MCP server (no webhook
// route/secret/gateway-env — reactivity is in-session `ours-mcp watch`), and a second run is a
// no-op that does not duplicate the block (idempotent).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));
const INSTALL = join(PKG, 'install.sh');

function run(openclawDir) {
  return execFileSync('bash', [INSTALL], {
    encoding: 'utf8',
    env: { ...process.env, OPENCLAW_DIR: openclawDir, OURS_INSTALL_SKIP_DAEMON: '1' },
  });
}

test('install.sh sets up skills + the ours MCP server (no route/secret); second run is idempotent', () => {
  const O = mkdtempSync(join(tmpdir(), 'openclaw-'));
  try {
    run(O);

    // skills installed under the OpenClaw skills dir
    assert.ok(existsSync(join(O, 'skills/ours/SKILL.md')), 'ours skill installed');
    assert.ok(existsSync(join(O, 'skills/writing-agent-bios/SKILL.md')), 'bios skill installed');

    // openclaw.json is strict JSON with the ours MCP server and NOTHING wake-related
    const cfgText = readFileSync(join(O, 'openclaw.json'), 'utf8');
    const cfg = JSON.parse(cfgText); // must be valid strict JSON
    assert.equal(cfg.mcp.servers.ours.command, 'ours-mcp', 'ours MCP server present');
    assert.deepEqual(cfg.mcp.servers.ours.args, ['proxy']);
    assert.ok(cfgText.includes('ours.network plugin'), 'managed sentinel present');
    assert.equal(cfg.plugins, undefined, 'no webhook routes written');

    // the connector/gateway approach is gone: no connector env, no gateway .env secret
    assert.ok(!existsSync(join(O, 'ours-connector.env')), 'no connector env file');
    assert.ok(!existsSync(join(O, '.env')), 'no gateway dotenv secret written');
    assert.doesNotMatch(cfgText, /ours-wake|sessionKey|secret/, 'no route/secret in config');

    // second run: idempotent — sentinel appears once
    run(O);
    const cfgText2 = readFileSync(join(O, 'openclaw.json'), 'utf8');
    assert.equal(
      (cfgText2.match(/ours\.network plugin \(managed block\)/g) || []).length,
      1,
      'block not duplicated',
    );
  } finally {
    rmSync(O, { recursive: true, force: true });
  }
});
