// Tests for the OpenClaw config-install planner (bin/openclaw-config-install.mjs).
// It decides, purely from the existing ~/.openclaw/openclaw.json text, how to install
// the ours MCP server WITHOUT ever clobbering a user's JSON5 file:
//   - no config / empty            -> write a fresh file
//   - strict JSON without our keys -> safe to deep-merge our block
//   - config already installed     -> noop (idempotent via sentinel)
//   - JSON5 / comments / unparsable -> manual (print + instruct, exit 3)
// Reactivity needs no config — wake is the agent tailing `ours-mcp watch` in-session, so there
// are no webhook routes / sessionKeys / secrets here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planConfigInstall,
  renderConfig,
  buildOursConfig,
  SENTINEL,
} from '../bin/openclaw-config-install.mjs';

const FRAGMENT = buildOursConfig();

test('empty / whitespace config -> write', () => {
  assert.equal(planConfigInstall('').action, 'write');
  assert.equal(planConfigInstall('   \n').action, 'write');
});

test('strict JSON without our keys -> merge', () => {
  const cfg = JSON.stringify({ mcp: { servers: { other: { command: 'x' } } } }, null, 2);
  assert.equal(planConfigInstall(cfg).action, 'merge');
});

test('already-installed config (sentinel present) -> noop', () => {
  const cfg = renderConfig('', FRAGMENT);
  assert.ok(cfg.includes(SENTINEL));
  assert.equal(planConfigInstall(cfg).action, 'noop');
});

test('JSON5 / comments (not strict JSON) -> manual (never clobber)', () => {
  const cfg = '{\n  // a comment JSON.parse cannot handle\n  mcp: { servers: {} },\n}\n';
  assert.equal(planConfigInstall(cfg).action, 'manual');
});

test('outright garbage -> manual (never clobber)', () => {
  assert.equal(planConfigInstall('this is not json at all {').action, 'manual');
});

test('fragment wires the MCP server + the sentinel, and NO webhook routes', () => {
  assert.equal(FRAGMENT['//ours'], SENTINEL);
  // MCP server points directly at the globally-installed daemon proxy
  assert.equal(FRAGMENT.mcp.servers.ours.command, 'ours-mcp');
  assert.deepEqual(FRAGMENT.mcp.servers.ours.args, ['proxy']);
  // the connector/gateway approach is gone — no webhooks plugin entry at all
  assert.equal(FRAGMENT.plugins, undefined, 'no plugins/webhooks routes');
});

test('render on empty writes valid JSON containing our keys', () => {
  const out = renderConfig('', FRAGMENT);
  const parsed = JSON.parse(out); // must be strict JSON
  assert.equal(parsed.mcp.servers.ours.command, 'ours-mcp');
  assert.equal(parsed['//ours'], SENTINEL);
  assert.equal(parsed.plugins, undefined);
});

test('render deep-merges into existing strict JSON, preserving unrelated keys', () => {
  const existing = JSON.stringify({
    theme: 'dark',
    mcp: { servers: { other: { command: 'keepme' } } },
    plugins: { entries: { somethingElse: { config: {} } } },
  });
  const out = renderConfig(existing, FRAGMENT);
  const parsed = JSON.parse(out);
  // unrelated keys survive
  assert.equal(parsed.theme, 'dark');
  assert.equal(parsed.mcp.servers.other.command, 'keepme');
  assert.ok(parsed.plugins.entries.somethingElse, 'unrelated plugins preserved');
  // ours keys added
  assert.equal(parsed.mcp.servers.ours.command, 'ours-mcp');
});

test('re-merging is idempotent (second merge equals first)', () => {
  const first = renderConfig('', FRAGMENT);
  const second = renderConfig(first, FRAGMENT);
  assert.equal(first, second);
});
