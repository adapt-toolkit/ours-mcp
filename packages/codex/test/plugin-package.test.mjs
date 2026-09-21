import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workspaceRoot = dirname(dirname(root));

test('npm artifact contains a valid native Codex plugin and all entry points', () => {
  // Inspect the already-built artifact. prepack deletes/rebuilds dist and races
  // parallel launcher/profile tests importing those same files.
  const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--dry-run'], { cwd: root, encoding: 'utf8' }))[0];
  const files = new Set(packed.files.map((file) => file.path));
  for (const path of ['.codex-plugin/plugin.json', '.mcp.json', 'hooks/hooks.json', 'bin/ours-codex.mjs', 'bin/proxy.mjs', 'bin/monitor-mcp.mjs', 'bin/network-watch.mjs', 'dist/monitor-mcp.mjs', 'dist/network-watch.mjs', 'skills/ours/SKILL.md', 'LICENSE', 'README.md']) {
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
  assert.ok(mcp.mcpServers.ours.env_vars.includes('OURS_CLIENT_PID'));
  assert.ok(mcp.mcpServers.ours.env_vars.includes('OURS_MCP_CONFIG'));
  assert.deepEqual(mcp.mcpServers.ours_monitor.env_vars.sort(), ['OURS_API_TOKEN', 'OURS_CODEX_CAPABILITY', 'OURS_CODEX_CONTROL_SOCKET', 'OURS_CONFIG', 'OURS_MCP_CONFIG', 'OURS_PORT', 'OURS_STATE_DIR']);
  assert.equal(mcp.mcpServers.ours_monitor.tool_timeout_sec, 86400);
});

test('shipped command entry points parse as JavaScript', () => {
  for (const file of ['ours-codex-install.mjs', 'ours-codex.mjs', 'monitor-mcp.mjs', 'network-watch.mjs', 'proxy.mjs']) {
    assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', join(root, 'bin', file)]));
  }
});

test('monitor MCP artifact runs with its declared SDK dependency and no main MCP package', () => {
  const isolated = mkdtempSync(join(tmpdir(), 'ours-codex-monitor-artifact-'));
  try {
    mkdirSync(join(isolated, 'bin'));
    mkdirSync(join(isolated, 'dist'));
    mkdirSync(join(isolated, 'node_modules/@ours.network'), { recursive: true });
    cpSync(join(root, 'bin/monitor-mcp.mjs'), join(isolated, 'bin/monitor-mcp.mjs'));
    cpSync(join(root, 'dist/monitor-mcp.mjs'), join(isolated, 'dist/monitor-mcp.mjs'));
    symlinkSync(join(workspaceRoot, 'node_modules/@ours.network/sdk'), join(isolated, 'node_modules/@ours.network/sdk'), 'dir');
    assert.equal(existsSync(join(isolated, 'node_modules/@ours.network/mcp')), false);
    assert.doesNotThrow(() => execFileSync(process.execPath, [join(isolated, 'bin/monitor-mcp.mjs')], {
      input: '', timeout: 5_000,
    }));
  } finally {
    rmSync(isolated, { recursive: true, force: true });
  }
});

test('built Codex entrypoints use the declared local MCP package', async () => {
  const isolated = mkdtempSync(join(tmpdir(), 'ours-codex-network-artifact-'));
  try {
    cpSync(root, isolated, { recursive: true, filter: (source) => !source.includes(`${join(root, 'node_modules')}`) });
    const manifest = JSON.parse(readFileSync(join(isolated, 'package.json'), 'utf8'));
    assert.equal(manifest.dependencies['@ours.network/mcp'], manifest.version);
    for (const artifact of ['dist/profile.mjs', 'dist/hooks-runner.mjs', 'dist/host-hooks.mjs', 'dist/network-watch.mjs']) {
      assert.ok(existsSync(join(isolated, artifact)), `package includes ${artifact}`);
    }
    mkdirSync(join(isolated, 'node_modules'), { recursive: true });
    for (const dependency of ['@modelcontextprotocol/sdk', '@ours.network/sdk', '@ours.network/mcp', 'ws', 'zod']) {
      const source = join(workspaceRoot, 'node_modules', dependency);
      if (!existsSync(source)) continue;
      const target = join(isolated, 'node_modules', dependency);
      mkdirSync(dirname(target), { recursive: true });
      symlinkSync(source, target, 'dir');
    }
    assert.equal(existsSync(join(isolated, 'node_modules/@ours.network/mcp')), true,
      'plugin carries the local MCP runtime');
    await import(pathToFileURL(join(isolated, 'dist/profile.mjs')));
    await import(pathToFileURL(join(isolated, 'dist/hooks-runner.mjs')));
    await import(pathToFileURL(join(isolated, 'dist/host-hooks.mjs')));
    await import(pathToFileURL(join(isolated, 'dist/network-watch.mjs')));
    await import(pathToFileURL(join(isolated, 'src/launcher.mjs')));
    const profile = join(isolated, 'profile.json');
    const credential = join(isolated, 'credential');
    const hostConfig = join(isolated, 'host', 'mcp-config.json');
    mkdirSync(dirname(hostConfig), { recursive: true });
    writeFileSync(credential, 'client-token\n', { mode: 0o600 });
    writeFileSync(profile, JSON.stringify({
      endpoint: 'http://127.0.0.1:4050',
      expectedInstanceId: 'b282ca8e-72d2-48cc-a948-b3c1a62129f5',
      credentialPath: credential,
    }), { mode: 0o600 });
    const selected = spawnSync(process.execPath, [join(isolated, 'bin/proxy.mjs')], {
      input: '', encoding: 'utf8',
      env: { HOME: isolated, OURS_CONFIG: profile, OURS_MCP_CONFIG: hostConfig, PATH: '/usr/local/bin:/usr/bin:/bin' },
    });
    assert.equal(selected.status, 0, selected.stderr);
  } finally {
    rmSync(isolated, { recursive: true, force: true });
  }
});
