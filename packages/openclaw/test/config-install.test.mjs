// Tests for the OpenClaw config-install planner (bin/openclaw-config-install.mjs).
// It decides, purely from the existing ~/.openclaw/openclaw.json text, how to install
// the ours MCP server WITHOUT ever clobbering a user's JSON5 file:
//   - no config / empty            -> write a fresh file
//   - strict JSON without our keys -> safe to deep-merge our block
//   - config already installed     -> noop (idempotent via the real mcp.servers.ours entry)
//   - strict JSON with legacy //ours-> merge (add server if needed + STRIP the bad root marker)
//   - JSON5 / comments / unparsable -> manual (print + instruct, exit 3)
// Idempotency is keyed off the REAL mcp.servers.ours entry — NOT a synthetic marker. OpenClaw's
// strict schema rejects unrecognized root keys, so the fragment must carry no `//`-prefixed keys
// and an old `//ours` marker must be stripped on upgrade (doctor-clean).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planConfigInstall,
  renderConfig,
  buildOursConfig,
  hasOursServer,
  LEGACY_ROOT_MARKER,
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

test('already-installed config (mcp.servers.ours present) -> noop', () => {
  const cfg = renderConfig('', FRAGMENT);
  assert.ok(hasOursServer(JSON.parse(cfg)));
  assert.equal(planConfigInstall(cfg).action, 'noop');
});

test('config with our server BUT a legacy //ours root marker -> merge (to heal), not noop', () => {
  const cfg = JSON.stringify({ '//ours': 'x', mcp: { servers: { ours: { command: 'ours-mcp', args: ['proxy'] } } } });
  assert.equal(planConfigInstall(cfg).action, 'merge', 'must rewrite to strip the bad key');
});

test('JSON5 / comments (not strict JSON) -> manual (never clobber)', () => {
  const cfg = '{\n  // a comment JSON.parse cannot handle\n  mcp: { servers: {} },\n}\n';
  assert.equal(planConfigInstall(cfg).action, 'manual');
});

test('outright garbage -> manual (never clobber)', () => {
  assert.equal(planConfigInstall('this is not json at all {').action, 'manual');
});

test('fragment wires ONLY the MCP server — no `//`-prefixed keys, no webhook routes', () => {
  // OpenClaw's strict schema rejects unrecognized root keys, so the fragment must have none.
  const badKeys = Object.keys(FRAGMENT).filter((k) => k.startsWith('//'));
  assert.deepEqual(badKeys, [], 'no `//`-prefixed keys in the fragment');
  assert.equal(FRAGMENT[LEGACY_ROOT_MARKER], undefined, 'no legacy //ours marker');
  // MCP server points directly at the globally-installed daemon proxy
  assert.equal(FRAGMENT.mcp.servers.ours.command, 'ours-mcp');
  assert.deepEqual(FRAGMENT.mcp.servers.ours.args, ['proxy']);
  // the connector/gateway approach is gone — no webhooks plugin entry at all
  assert.equal(FRAGMENT.plugins, undefined, 'no plugins/webhooks routes');
});

test('render on empty writes valid JSON with our server and NO `//`-prefixed root keys', () => {
  const out = renderConfig('', FRAGMENT);
  const parsed = JSON.parse(out); // must be strict JSON
  assert.equal(parsed.mcp.servers.ours.command, 'ours-mcp');
  assert.deepEqual(Object.keys(parsed).filter((k) => k.startsWith('//')), [], 'no `//` root keys');
  assert.equal(parsed.plugins, undefined);
});

test('render STRIPS a pre-existing legacy //ours root marker (self-heals to doctor-clean)', () => {
  const existing = JSON.stringify({ '//ours': 'ours.network plugin (managed block)', theme: 'dark' });
  const parsed = JSON.parse(renderConfig(existing, FRAGMENT));
  assert.equal(parsed[LEGACY_ROOT_MARKER], undefined, 'legacy //ours removed');
  assert.equal(parsed.theme, 'dark', 'unrelated keys preserved');
  assert.equal(parsed.mcp.servers.ours.command, 'ours-mcp', 'our server present');
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
