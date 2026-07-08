// Tests for the Hermes config-install planner (bin/hermes-config-install.mjs).
// It decides, purely from the existing ~/.hermes/config.yaml text, how to install
// the ours blocks WITHOUT ever corrupting a user's YAML:
//   - no config / empty            -> write a fresh file
//   - config without our top keys  -> safe to append our block
//   - config already installed     -> noop (idempotent via sentinel)
//   - config with existing mcp_servers: or platforms: -> manual (print + instruct)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planConfigInstall, renderConfigBlock, SENTINEL } from '../bin/hermes-config-install.mjs';

const BLOCK = renderConfigBlock({ secret: 's3cr3t', webhookPort: 8644, identities: ['Alice', 'Bob'] });

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

test('existing platforms: top-level -> manual (never corrupt)', () => {
  const cfg = 'platforms:\n  telegram:\n    enabled: true\n';
  assert.equal(planConfigInstall(cfg).action, 'manual');
});

test('rendered block wires the MCP server, the ours-wake route, and the sentinel', () => {
  assert.match(BLOCK, /^# >>> ours\.network plugin/m);
  assert.match(BLOCK, /mcp_servers:/);
  // MCP server points directly at the globally-installed daemon proxy
  assert.match(BLOCK, /ours:\s*\n\s*command:\s*["']?ours-mcp["']?/);
  assert.match(BLOCK, /args:\s*\[\s*["']proxy["']\s*\]/);
  // webhook route the connector pokes
  assert.match(BLOCK, /platforms:\s*\n\s*webhook:/);
  assert.match(BLOCK, /ours-wake:/);
  assert.match(BLOCK, /events:\s*\[\s*["']ours_wake["']\s*\]/);
  assert.match(BLOCK, /secret:\s*["']?s3cr3t["']?/);
  assert.match(BLOCK, /skills:\s*\[\s*["']ours["']\s*\]/);
  // the drain prompt references the poked identity via dot-notation
  assert.match(BLOCK, /\{identity\}/);
});

test('rendered block is valid: appending it after a config keeps the sentinel once', () => {
  const cfg = 'model:\n  provider: nous\n';
  const merged = cfg + '\n' + BLOCK;
  assert.equal(merged.match(new RegExp(SENTINEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')).length, 1);
});
