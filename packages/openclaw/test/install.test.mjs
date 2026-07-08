// Integration test for install.sh in a sandbox OPENCLAW_DIR (no daemon, no watcher).
// Verifies: skills are installed, openclaw.json gets the ours MCP server + a per-identity
// webhook route with a real generated token, an env file records that same token, and a
// second run is a no-op that neither duplicates the block nor rotates the token (idempotent).
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
    env: {
      ...process.env,
      OPENCLAW_DIR: openclawDir,
      CONNECTOR_IDENTITIES: 'Alice',
      OURS_INSTALL_SKIP_DAEMON: '1',
      OURS_INSTALL_SKIP_WATCHER: '1',
    },
  });
}
const tokenOf = (envText) => (envText.match(/OURS_WAKE_SECRET="([^"]+)"/) || [])[1];

test('install.sh sets up skills, config, and env; second run is idempotent', () => {
  const O = mkdtempSync(join(tmpdir(), 'openclaw-'));
  try {
    run(O);

    // skills installed under the OpenClaw skills dir
    assert.ok(existsSync(join(O, 'skills/ours/SKILL.md')), 'ours skill installed');
    assert.ok(existsSync(join(O, 'skills/writing-agent-bios/SKILL.md')), 'bios skill installed');

    // openclaw.json is strict JSON with the ours MCP server + a per-identity route
    const cfgText = readFileSync(join(O, 'openclaw.json'), 'utf8');
    const cfg = JSON.parse(cfgText); // must be valid strict JSON
    assert.equal(cfg.mcp.servers.ours.command, 'ours-mcp', 'ours MCP server present');
    assert.deepEqual(cfg.mcp.servers.ours.args, ['proxy']);
    const routes = cfg.plugins.entries.webhooks.config.routes;
    assert.ok(routes['ours-wake-alice'], 'per-identity route present');
    assert.equal(routes['ours-wake-alice'].sessionKey, 'agent:alice:main');
    assert.ok(cfgText.includes('ours.network plugin'), 'managed sentinel present');

    // a real (non-default) token was generated and shared into route secret + env
    const env1 = readFileSync(join(O, 'ours-connector.env'), 'utf8');
    const token = tokenOf(env1);
    assert.ok(token && token !== 'CHANGE_ME_local_webhook_hmac', 'generated a real token');
    assert.match(env1, /CONNECTOR_AUTH_HEADER="Authorization: Bearer /, 'connector sends static bearer token');
    assert.equal(routes['ours-wake-alice'].secret.id, 'OURS_WAKE_SECRET', 'route resolves the shared token env var');

    // second run: idempotent — sentinel appears once, token not rotated
    run(O);
    const cfgText2 = readFileSync(join(O, 'openclaw.json'), 'utf8');
    assert.equal(
      (cfgText2.match(/ours\.network plugin \(managed block\)/g) || []).length,
      1,
      'block not duplicated',
    );
    assert.equal(tokenOf(readFileSync(join(O, 'ours-connector.env'), 'utf8')), token, 'token not rotated');
  } finally {
    rmSync(O, { recursive: true, force: true });
  }
});
