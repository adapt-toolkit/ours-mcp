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

test('already-associated managed block is idempotent; legacy block is migrated', () => {
  assert.equal(planConfigInstall(BLOCK).action, 'noop');
  const legacy = BLOCK.replace(', "--application", "hermes"', '');
  assert.equal(planConfigInstall(legacy).action, 'replace');
  const incomplete = `model:\n  provider: nous\n\n${SENTINEL}\nmcp_servers:\n`;
  assert.equal(planConfigInstall(incomplete).action, 'manual');
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
  assert.match(BLOCK, /args:\s*\[\s*["']proxy["']\s*,\s*["']--application["']\s*,\s*["']hermes["']\s*\]/);
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
