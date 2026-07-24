// Integration test for install.sh in a sandbox OPENCODE_DIR (no daemon, no zod network install —
// OURS_INSTALL_SKIP_DAEMON=1 skips both). Verifies: skills + the ours-monitor plugin FILE are
// installed, opencode.json gets the ours MCP server + plugin registration block, there is NO
// webhook/route/secret/connector-env (reactivity is the ours-monitor plugin's autonomous
// tool-driven watch, not a webhook), and a second run is a no-op that does not duplicate the
// block (idempotent).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));
const INSTALL = join(PKG, 'install.sh');

function run(opencodeDir) {
  return execFileSync('bash', [INSTALL], {
    encoding: 'utf8',
    env: { ...process.env, OPENCODE_DIR: opencodeDir, OURS_INSTALL_SKIP_DAEMON: '1' },
  });
}

test('install.sh sets up skills + the ours MCP server (no route/secret); second run is idempotent', () => {
  const D = mkdtempSync(join(tmpdir(), 'opencode-'));
  try {
    run(D);

    assert.ok(existsSync(join(D, 'skills/ours/SKILL.md')), 'ours skill installed');
    assert.ok(existsSync(join(D, 'skills/ours/references/configuration.md')), 'ours skill references installed');
    assert.ok(existsSync(join(D, 'skills/writing-agent-bios/SKILL.md')), 'bios skill installed');
    assert.ok(existsSync(join(D, 'plugin/ours-monitor.mjs')), 'ours-monitor plugin file installed');
    assert.ok(existsSync(join(D, 'plugin/ours-monitor.impl.mjs')), 'ours-monitor impl file installed (the plugin entry imports it)');

    const cfg = readFileSync(join(D, 'opencode.json'), 'utf8');
    assert.match(cfg, /\/\/ >>> ours\.network plugin/, 'managed sentinel present');
    assert.match(cfg, /"command": \["ours-mcp", "proxy"\]/, 'ours MCP server present');
    assert.match(cfg, /"plugin": \[".*ours-monitor\.mjs"\]/, 'ours-monitor plugin registration present');
    assert.match(cfg, new RegExp(join(D, 'plugin', 'ours-monitor.mjs').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'plugin entry points at the installed copy, not the source repo');
    assert.doesNotMatch(cfg, /ours-wake|webhook|secret/i, 'no webhook/route/secret');

    assert.ok(!existsSync(join(D, 'ours-connector.env')), 'no connector env file');

    // second run: idempotent — exactly one sentinel block, skills re-copied cleanly
    run(D);
    const cfg2 = readFileSync(join(D, 'opencode.json'), 'utf8');
    assert.equal((cfg2.match(/\/\/ >>> ours\.network plugin/g) || []).length, 1, 'block not duplicated');
    assert.equal(cfg, cfg2, 'second run leaves config byte-identical (true no-op)');
  } finally {
    rmSync(D, { recursive: true, force: true });
  }
});

test('install.sh does not clobber an existing opencode.json that already defines mcp:', () => {
  const D = mkdtempSync(join(tmpdir(), 'opencode-'));
  try {
    const preexisting = '{\n  "mcp": { "filesystem": { "type": "local", "command": ["npx", "fs"] } }\n}\n';
    mkdirSync(D, { recursive: true });
    writeFileSync(join(D, 'opencode.json'), preexisting);

    // install.sh treats the config-installer's exit-3 (manual merge needed) as non-fatal —
    // same convention as hermes's install.sh: it prints guidance and still exits 0 overall,
    // because the daemon+skills steps it already completed are real, useful work.
    const out = run(D);
    assert.match(out, /merge/i, 'prints manual-merge guidance');

    const cfg = readFileSync(join(D, 'opencode.json'), 'utf8');
    assert.equal(cfg, preexisting, "the user's existing mcp: config is left completely untouched");
    assert.ok(existsSync(join(D, 'skills/ours/SKILL.md')), 'skills step still runs even when config needs a manual merge');
    assert.ok(existsSync(join(D, 'plugin/ours-monitor.mjs')), 'plugin file is still installed even when config needs a manual merge');
    assert.ok(existsSync(join(D, 'plugin/ours-monitor.impl.mjs')), 'impl file is still installed even when config needs a manual merge');
  } finally {
    rmSync(D, { recursive: true, force: true });
  }
});

test('install.sh does not clobber an existing opencode.json that already defines plugin: (independent of mcp)', () => {
  const D = mkdtempSync(join(tmpdir(), 'opencode-'));
  try {
    const preexisting = '{\n  "plugin": ["some-other-plugin.mjs"]\n}\n';
    mkdirSync(D, { recursive: true });
    writeFileSync(join(D, 'opencode.json'), preexisting);

    const out = run(D);
    assert.match(out, /merge/i, 'prints manual-merge guidance');

    const cfg = readFileSync(join(D, 'opencode.json'), 'utf8');
    assert.equal(cfg, preexisting, "the user's existing plugin: config is left completely untouched");
  } finally {
    rmSync(D, { recursive: true, force: true });
  }
});
