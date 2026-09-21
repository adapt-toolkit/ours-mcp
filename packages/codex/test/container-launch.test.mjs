// Incomplete legacy profiles must never execute a server-side MCP through Docker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

for (const plugin of ['codex', 'claude-code']) {
  for (const [scenario, contents, mode, reason] of [
    ['partial legacy tuple', JSON.stringify({ composeFile: '/compose.yml', expectedInstanceId: 'legacy' }), 0o600, /complete host profile/],
    ['public profile', JSON.stringify({ endpoint: 'http://127.0.0.1:1', expectedInstanceId: '00000000-0000-0000-0000-000000000001', credentialPath: '/private/token' }), 0o644, /private permissions/],
    ['corrupt profile', '{"composeFile":', 0o600, /not valid JSON/],
  ]) test(`${plugin} refuses ${scenario} without invoking Docker or falling back`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'ours-legacy-profile-refusal-'));
    try {
      const profile = join(dir, 'profile.json');
      const marker = join(dir, 'launched');
      writeFileSync(profile, contents, { mode });
      for (const command of ['docker', 'ours-mcp']) writeFileSync(join(dir, command), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected');`, { mode: 0o700 });
      const env = { ...process.env, HOME: dir, PATH: dir, OURS_CONFIG: profile };
      for (const key of ['OURS_API_TOKEN', 'OURS_PORT', 'OURS_STATE_DIR', 'OURS_DAEMON_ID']) delete env[key];
      const result = spawnSync(process.execPath, [fileURLToPath(new URL(`../../${plugin}/bin/proxy.mjs`, import.meta.url))], { env, encoding: 'utf8', timeout: 5000 });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, reason);
      assert.equal(existsSync(marker), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
