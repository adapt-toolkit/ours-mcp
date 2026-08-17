// Tests for the Hermes config-install planner (bin/hermes-config-install.mjs).
// It decides, purely from the existing ~/.hermes/config.yaml text, how to install
// the ours MCP server WITHOUT ever corrupting a user's YAML:
//   - no config / empty            -> write a fresh file
//   - config without our top keys  -> safe to append our block
//   - config already installed     -> noop (idempotent via sentinel)
//   - config with existing mcp_servers: -> manual (print + instruct)
// Reactivity needs no config — wake is the agent tailing `ours-mcp watch` in-session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planConfigInstall, renderConfigBlock, SENTINEL } from '../bin/hermes-config-install.mjs';

const BLOCK = renderConfigBlock();

test('empty config -> write', () => {
  assert.equal(planConfigInstall('').action, 'write');
  assert.equal(planConfigInstall('   \n').action, 'write');
});

test('config without our top-level keys -> append', () => {
  const cfg = 'model:\n  provider: nous\n  name: hermes-4\n';
  assert.equal(planConfigInstall(cfg).action, 'append');
});

test('already-installed config (sentinel present) -> noop', () => {
  const cfg = `model:\n  provider: nous\n\n${SENTINEL}\nmcp_servers:\n  ours:\n    command: ours-mcp\n`;
  assert.equal(planConfigInstall(cfg).action, 'noop');
});

test('existing mcp_servers: top-level -> manual (never corrupt)', () => {
  const cfg = 'mcp_servers:\n  filesystem:\n    command: npx\n';
  assert.equal(planConfigInstall(cfg).action, 'manual');
});

test('rendered block wires the MCP server + sentinel, and NO webhook/route/secret', () => {
  assert.match(BLOCK, /^# >>> ours\.network plugin/m);
  assert.match(BLOCK, /mcp_servers:/);
  // MCP server points directly at the globally-installed daemon proxy
  assert.match(BLOCK, /ours:\s*\n\s*command:\s*["']?ours-mcp["']?/);
  assert.match(BLOCK, /args:\s*\[\s*["']proxy["']\s*\]/);
  // the connector/gateway approach is gone — no webhook platform, route, or secret in the block
  assert.doesNotMatch(BLOCK, /platforms:/);
  assert.doesNotMatch(BLOCK, /ours-wake/);
  assert.doesNotMatch(BLOCK, /secret:/);
  assert.doesNotMatch(BLOCK, /webhook/i);
});

test('rendered block is valid: appending it after a config keeps the sentinel once', () => {
  const cfg = 'model:\n  provider: nous\n';
  const merged = cfg + '\n' + BLOCK;
  assert.equal(merged.match(new RegExp(SENTINEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')).length, 1);
});

// ── the daemon pair (installer v3 §5) ─────────────────────────────────────────
// A Hermes installed for a NON-DEFAULT state directory must attach to that
// daemon, not to ~/.ours. `ours-mcp proxy` falls back to the default when
// nothing says otherwise, so without this the operator is told one daemon was
// chosen and silently gets another. Hermes is the only one of the three
// harnesses where this is possible — we own this writer.

test('no ours config given -> the block is unchanged, byte for byte', () => {
  // The default state directory, and every install that predates this argument.
  assert.equal(renderConfigBlock(), renderConfigBlock({ oursConfig: null }));
  assert.equal(renderConfigBlock(), renderConfigBlock({ oursConfig: '   ' }));
  assert.ok(!renderConfigBlock().includes('env:'), 'no env block appears when none was asked for');
  assert.ok(!renderConfigBlock().includes('OURS_CONFIG'));
});

test('an ours config is emitted as an env block carrying OURS_CONFIG', () => {
  const block = renderConfigBlock({ oursConfig: '/home/me/.ours-tg/config.json' });
  assert.match(block, /^\s{4}env:$/m);
  assert.match(block, /^\s{6}OURS_CONFIG: "\/home\/me\/\.ours-tg\/config\.json"$/m);
  // It belongs to the ours server, between its args and its enabled flag —
  // indentation is the whole meaning in YAML.
  assert.match(block, /args:\s*\[\s*["']proxy["']\s*\]\n\s{4}env:\n\s{6}OURS_CONFIG:.*\n\s{4}enabled: true/);
});

test('OURS_CONFIG is the ONLY thing the env block carries', () => {
  // Not a general environment passthrough: anything else here would be a second
  // place a daemon gets named, and the pair would stop being one decision.
  const block = renderConfigBlock({ oursConfig: '/home/me/.ours-tg/config.json' });
  const env = block.split(/^\s{4}env:$/m)[1].split(/^\s{4}enabled:/m)[0];
  const keys = env.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => l.split(':')[0]);
  assert.deepEqual(keys, ['OURS_CONFIG']);
});

test('a path with spaces or a quote survives the block intact', () => {
  const block = renderConfigBlock({ oursConfig: '/home/me/my "ours" dir/config.json' });
  assert.ok(block.includes(String.raw`OURS_CONFIG: "/home/me/my \"ours\" dir/config.json"`));
  // And the block still parses as the same shape: sentinel, server, end.
  assert.match(block, /^# >>> ours\.network plugin/m);
  assert.match(block, /^# <<< ours\.network plugin$/m);
});

test('the plan is unaffected by the env block — a sentinel is still a noop', () => {
  const installed = renderConfigBlock({ oursConfig: '/home/me/.ours-tg/config.json' });
  assert.equal(planConfigInstall(installed).action, 'noop');
  assert.equal(planConfigInstall(`model:\n  provider: nous\n\n${installed}`).action, 'noop');
});
