import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test('npm artifact contains a valid native Codex plugin and all entry points', () => {
  const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--dry-run'], { cwd: root, encoding: 'utf8' }))[0];
  const files = new Set(packed.files.map((file) => file.path));
  for (const path of ['.codex-plugin/plugin.json', '.mcp.json', 'hooks/hooks.json', 'bin/ours-codex.mjs', 'bin/proxy.mjs', 'bin/monitor-mcp.mjs', 'dist/monitor-mcp.mjs', 'skills/ours/SKILL.md', 'LICENSE', 'README.md']) {
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
    assert.equal(config.cwd, '.', 'Codex resolves plugin-relative MCP commands from cwd');
  }
  assert.ok(mcp.mcpServers.ours.env_vars.includes('OURS_PORT'));
  assert.ok(mcp.mcpServers.ours.env_vars.includes('OURS_API_TOKEN'));
  assert.deepEqual(mcp.mcpServers.ours_monitor.env_vars.sort(), ['OURS_API_TOKEN', 'OURS_CODEX_CAPABILITY', 'OURS_CODEX_CONTROL_SOCKET', 'OURS_CONFIG', 'OURS_PORT', 'OURS_STATE_DIR']);
  assert.equal(mcp.mcpServers.ours_monitor.tool_timeout_sec, 86400);
});

test('shipped command entry points parse as JavaScript', () => {
  for (const file of ['ours-codex-install.mjs', 'ours-codex.mjs', 'monitor-mcp.mjs', 'proxy.mjs']) {
    assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', join(root, 'bin', file)]));
  }
});

test('monitor MCP artifact runs without an installed dependency tree', () => {
  const isolated = mkdtempSync(join(tmpdir(), 'ours-codex-monitor-artifact-'));
  try {
    mkdirSync(join(isolated, 'bin'));
    mkdirSync(join(isolated, 'dist'));
    cpSync(join(root, 'bin/monitor-mcp.mjs'), join(isolated, 'bin/monitor-mcp.mjs'));
    cpSync(join(root, 'dist/monitor-mcp.mjs'), join(isolated, 'dist/monitor-mcp.mjs'));
    assert.doesNotThrow(() => execFileSync(process.execPath, [join(isolated, 'bin/monitor-mcp.mjs')], {
      input: '', timeout: 5_000,
    }));
  } finally {
    rmSync(isolated, { recursive: true, force: true });
  }
});
