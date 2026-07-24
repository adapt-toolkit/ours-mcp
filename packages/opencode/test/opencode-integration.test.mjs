// INTEGRATION-TIER: exercises the REAL opencode-ai binary against our merged config, not just
// our own tokenizer's opinion of validity. opencode hard-fails its ENTIRE startup on a malformed
// or wrongly-shaped config (not just the ours server) — see README "opencode.json is strict" — so
// config-install.test.mjs's structural proofs are necessary but not sufficient; this suite is the
// ground truth.
//
// Installs opencode-ai@latest into an isolated, throwaway npm prefix (once, in `before`) and runs
// it with HOME pointed at a per-test sandbox, so nothing here touches the real host. If the
// install fails (no network, registry unreachable — e.g. in a sandboxed CI runner), every test in
// this file skips gracefully via t.skip(); it must still run locally where npm has network access.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  planConfigInstall,
  renderFreshConfig,
  insertBlock,
  upgradeBlock,
  SENTINEL,
  SENTINEL_END,
} from '../bin/opencode-config-install.mjs';

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));

let BIN = null;
let SETUP_DIR = null;
let SKIP_REASON = null;

before(() => {
  SETUP_DIR = mkdtempSync(join(tmpdir(), 'opencode-bin-'));
  try {
    execFileSync('npm', ['install', 'opencode-ai@latest', '--no-save', '--no-audit', '--no-fund'], {
      cwd: SETUP_DIR,
      stdio: 'pipe',
      timeout: 180_000,
    });
    const candidate = join(SETUP_DIR, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
    if (!existsSync(candidate)) throw new Error('opencode-ai installed but binary not found at expected path');
    chmodSync(candidate, 0o755);
    BIN = candidate;
  } catch (err) {
    BIN = null;
    SKIP_REASON = `opencode-ai unavailable (npm install failed: ${err.message}) — integration-tier, skipping`;
  }
});

after(() => {
  if (SETUP_DIR) rmSync(SETUP_DIR, { recursive: true, force: true });
});

// Runs `opencode debug config` with HOME pointed at `home` and returns the parsed resolved
// config. Throws (test failure, not skip) if opencode itself hard-fails — that's the real bug
// this suite exists to catch.
function resolvedConfig(home) {
  const out = execFileSync(BIN, ['debug', 'config'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
    timeout: 30_000,
  });
  return JSON.parse(out);
}

function sandboxHome() {
  return mkdtempSync(join(tmpdir(), 'opencode-home-'));
}

function assertOursWired(parsed) {
  assert.deepEqual(parsed.mcp.ours, { type: 'local', command: ['ours-mcp', 'proxy'], enabled: true });
}

test('REQUIRED 8a (fresh-write) — a freshly-written config (no prior opencode.json) is accepted by real opencode, mcp.ours echoed back unchanged', (t) => {
  if (!BIN) return t.skip(SKIP_REASON);
  const home = sandboxHome();
  try {
    const dir = join(home, '.config', 'opencode');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'opencode.json'), renderFreshConfig());

    const parsed = resolvedConfig(home);
    assertOursWired(parsed);
    assert.equal(parsed.$schema, 'https://opencode.ai/config.json');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('REQUIRED 8b (append-to-existing-config) — merging into a realistic pre-existing config is accepted by real opencode; original settings + mcp.ours both survive', (t) => {
  if (!BIN) return t.skip(SKIP_REASON);
  const home = sandboxHome();
  try {
    const dir = join(home, '.config', 'opencode');
    mkdirSync(dir, { recursive: true });
    const existing = `{
  // a user's pre-existing config
  "$schema": "https://opencode.ai/config.json",
  "instructions": [],
  "autoshare": false
}
`;
    const plan = planConfigInstall({ json: existing });
    assert.equal(plan.action, 'append');
    const merged = insertBlock(existing, plan.insertOffset, plan.needsComma);
    writeFileSync(join(dir, 'opencode.json'), merged);

    const parsed = resolvedConfig(home);
    assertOursWired(parsed);
    assert.deepEqual(parsed.instructions, []);
    assert.equal(parsed.autoshare, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('REQUIRED 8c (idempotent second-run) — applying the planner a second time is a no-op, and the unchanged file is still accepted by real opencode', (t) => {
  if (!BIN) return t.skip(SKIP_REASON);
  const home = sandboxHome();
  try {
    const dir = join(home, '.config', 'opencode');
    mkdirSync(dir, { recursive: true });
    const existing = '{\n  "autoshare": false\n}\n';

    const firstPlan = planConfigInstall({ json: existing });
    const afterFirst = insertBlock(existing, firstPlan.insertOffset, firstPlan.needsComma);
    writeFileSync(join(dir, 'opencode.json'), afterFirst);

    // Second application: the planner routes through the sentinel-present upgrade path, and
    // since afterFirst was rendered with the SAME options as this second call, upgradeBlock must
    // report a true no-op (byte-identical) rather than a needless rewrite.
    const secondPlan = planConfigInstall({ json: afterFirst });
    assert.equal(secondPlan.action, 'upgrade');
    const secondResult = upgradeBlock(afterFirst, secondPlan.span);
    assert.equal(secondResult.changed, false);
    assert.equal(secondResult.text, afterFirst);

    // The file opencode actually loads is exactly what the first run produced.
    const parsed = resolvedConfig(home);
    assertOursWired(parsed);
    assert.equal(parsed.autoshare, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('REQUIRED — a stale mcp-only managed block is UPGRADED to include the plugin key, and the upgraded config is still accepted by real opencode', (t) => {
  if (!BIN) return t.skip(SKIP_REASON);
  const home = sandboxHome();
  try {
    const dir = join(home, '.config', 'opencode');
    mkdirSync(dir, { recursive: true });
    // Exactly what an older install's opencode.json looks like: our sentinel present, but the
    // managed block's body pre-dates the `plugin` key entirely.
    const staleConfig = `{
  "autoshare": false,
  ${SENTINEL}
  "mcp": {
    "ours": {
      "type": "local",
      "command": ["ours-mcp", "proxy"],
      "enabled": true
    }
  }
  ${SENTINEL_END}
}
`;
    writeFileSync(join(dir, 'opencode.json'), staleConfig);

    const plan = planConfigInstall({ json: staleConfig });
    assert.equal(plan.action, 'upgrade', 'a stale block must route through upgrade, not a blind noop');
    const pluginPath = join(dir, 'plugin', 'ours-monitor.mjs');
    const result = upgradeBlock(staleConfig, plan.span, { pluginPath });
    assert.equal(result.changed, true, 'the stale block lacks the plugin key -> must actually change');
    writeFileSync(join(dir, 'opencode.json'), result.text);

    const parsed = resolvedConfig(home);
    assertOursWired(parsed);
    assert.equal(parsed.autoshare, false, 'content outside the managed block survived the upgrade');
    // Real opencode normalizes a plain filesystem path into a file:// URL in its resolved
    // config — assert the plugin entry POINTS AT our path, not byte-equality against it.
    assert.equal(parsed.plugin.length, 1, 'the ours-monitor plugin registration is now present after upgrading a stale host');
    assert.match(parsed.plugin[0], /ours-monitor\.mjs$/);
    assert.ok(parsed.plugin[0].endsWith(pluginPath) || parsed.plugin[0] === `file://${pluginPath}`, `expected plugin entry to resolve to ${pluginPath}, got ${parsed.plugin[0]}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('REQUIRED 8d — a deliberately malformed mcp.ours shape is REJECTED by real opencode (hard-fail is real, not assumed)', (t) => {
  if (!BIN) return t.skip(SKIP_REASON);
  const home = sandboxHome();
  try {
    const dir = join(home, '.config', 'opencode');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'opencode.json'),
      '{ "mcp": { "ours": { "type": "local", "command": "not-an-array" } } }',
    );
    assert.throws(() => resolvedConfig(home), /nvalid|xpected array/, 'opencode refuses to start on a bad mcp.command shape');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
