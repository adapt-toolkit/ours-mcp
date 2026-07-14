import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test('npm artifact contains a valid native Codex plugin and all entry points', () => {
  const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--dry-run'], { cwd: root, encoding: 'utf8' }))[0];
  const files = new Set(packed.files.map((file) => file.path));
  for (const path of ['.codex-plugin/plugin.json', '.mcp.json', 'hooks/hooks.json', 'bin/ours-codex.mjs', 'bin/proxy.mjs', 'bin/monitor-mcp.mjs', 'skills/ours/SKILL.md', 'LICENSE', 'README.md']) {
    assert.ok(files.has(path), `package includes ${path}`);
  }
  const manifest = JSON.parse(readFileSync(join(root, '.codex-plugin/plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'ours');
  for (const field of ['skills', 'mcpServers']) {
    const relative = manifest[field];
    assert.ok(relative.startsWith('./'));
    assert.ok(existsSync(join(root, normalize(relative))), `${field} target exists`);
  }
  assert.ok(existsSync(join(root, 'hooks/hooks.json')), 'default bundled hook config exists');
  const mcp = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'));
  assert.deepEqual(Object.keys(mcp.mcpServers).sort(), ['ours', 'ours_monitor']);
  for (const config of Object.values(mcp.mcpServers)) {
    const script = config.args[0].replace('${PLUGIN_ROOT}/', '');
    assert.ok(existsSync(join(root, script)), `${script} exists`);
  }
});
