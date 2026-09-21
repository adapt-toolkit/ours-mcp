import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workspaceRoot = dirname(dirname(root));

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
