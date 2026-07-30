// Tests for the OpenCode config-install planner (bin/opencode-config-install.mjs).
// It decides, purely from the existing text of BOTH ~/.config/opencode/opencode.json AND
// opencode.jsonc (OpenCode loads and merges both), how to install the ours MCP server AND
// the ours-monitor plugin registration WITHOUT ever corrupting or duplicating into either
// file:
//   - no config anywhere                          -> write a fresh opencode.json
//   - config without top-level mcp:/plugin: keys   -> safe to insert before the closing brace
//   - our sentinel already present (in EITHER file) -> upgrade: re-render the managed block IN
//     PLACE at its existing span, so a stale block (e.g. an mcp-only block from before the
//     `plugin` key existed) gets brought current — a true noop only when the installed block
//     ALREADY byte-matches what we'd render today
//   - a top-level mcp: OR plugin: key already exists (in EITHER file, checked
//     INDEPENDENTLY) -> manual (print + instruct)
//   - anything not a well-formed single top-level JSON(C) object -> manual (never guess)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planConfigInstall,
  renderConfigBlock,
  renderFreshConfig,
  insertBlock,
  findManagedBlockSpan,
  upgradeBlock,
  analyzeJsonc,
  stripJsoncComments,
  defaultPluginPath,
  SENTINEL,
  SENTINEL_END,
} from '../bin/opencode-config-install.mjs';

// A fixed, deterministic plugin path for tests — never rely on the real homedir()/env.
const TEST_PLUGIN_PATH = '/test-home/.config/opencode/plugin/ours-monitor.mjs';
const withPlugin = { pluginPath: TEST_PLUGIN_PATH };

// ---------------------------------------------------------------------------
// planConfigInstall — the top-level decision matrix
// ---------------------------------------------------------------------------

test('no config anywhere -> write', () => {
  assert.equal(planConfigInstall({}).action, 'write');
  assert.equal(planConfigInstall({ json: '', jsonc: '' }).action, 'write');
  assert.equal(planConfigInstall({ json: '   \n', jsonc: '\t' }).action, 'write');
});

test('config without a top-level mcp: key -> append (pretty-printed)', () => {
  const cfg = '{\n  "model": "anthropic/claude"\n}\n';
  const plan = planConfigInstall({ json: cfg });
  assert.equal(plan.action, 'append');
  assert.equal(plan.target, 'json');
});

test('REQUIRED 2 — minified/single-line JSON with a conflicting mcp: key -> manual', () => {
  const cfg = '{"model":"anthropic/claude","mcp":{"filesystem":{"type":"local","command":["npx","fs"]}}}';
  const plan = planConfigInstall({ json: cfg });
  assert.equal(plan.action, 'manual');
});

test('minified JSON WITHOUT a conflicting key -> still append (proves minification alone is not the trigger)', () => {
  const cfg = '{"model":"anthropic/claude","instructions":["a.md"]}';
  const plan = planConfigInstall({ json: cfg });
  assert.equal(plan.action, 'append');
});

test('already-installed (sentinel in opencode.json) -> upgrade, targeting json, with a locatable span', () => {
  const cfg = `{\n  "model": "x",\n  ${SENTINEL}\n  "mcp": { "ours": { "type": "local", "command": ["ours-mcp"] } }\n  ${SENTINEL_END}\n}\n`;
  const plan = planConfigInstall({ json: cfg });
  assert.equal(plan.action, 'upgrade');
  assert.equal(plan.target, 'json');
  assert.ok(plan.span);
  assert.equal(cfg.slice(plan.span.blockStart, plan.span.blockStart + SENTINEL.length), SENTINEL);
});

test('REQUIRED 4a — already-installed (sentinel in opencode.jsonc ONLY, json is a different file) -> upgrade targeting jsonc, not a second install', () => {
  const json = '{\n  "model": "x"\n}\n';
  const jsonc = `{\n  ${SENTINEL}\n  "mcp": { "ours": { "type": "local", "command": ["ours-mcp"] } }\n  ${SENTINEL_END}\n}\n`;
  const plan = planConfigInstall({ json, jsonc });
  assert.equal(plan.action, 'upgrade');
  assert.equal(plan.target, 'jsonc');
});

test('sentinel present in BOTH opencode.json and opencode.jsonc -> manual (ambiguous, no single safe splice point)', () => {
  const block = `{\n  ${SENTINEL}\n  "mcp": {}\n  ${SENTINEL_END}\n}\n`;
  const plan = planConfigInstall({ json: block, jsonc: block });
  assert.equal(plan.action, 'manual');
  assert.match(plan.reason, /both/i);
});

test('sentinel present but its end marker is missing -> manual, never guesses at a hand-edited block', () => {
  const cfg = `{\n  "model": "x",\n  ${SENTINEL}\n  "mcp": { "ours": {} }\n}\n`; // no SENTINEL_END
  const plan = planConfigInstall({ json: cfg });
  assert.equal(plan.action, 'manual');
});

test('REQUIRED 6 (a) — top-level mcp: conflict in opencode.json alone -> manual', () => {
  const json = '{\n  "mcp": { "filesystem": {} }\n}\n';
  const plan = planConfigInstall({ json, jsonc: '' });
  assert.equal(plan.action, 'manual');
});

test('REQUIRED 6 (b) — top-level mcp: conflict in opencode.jsonc alone (json absent) -> manual, independent of 6(a)', () => {
  const jsonc = '{\n  "mcp": { "filesystem": {} }\n}\n';
  const plan = planConfigInstall({ json: '', jsonc });
  assert.equal(plan.action, 'manual');
});

test('REQUIRED 5 (f) — top-level plugin: conflict in opencode.json alone -> manual, INDEPENDENT of mcp', () => {
  const json = '{\n  "plugin": ["some-other-plugin.mjs"]\n}\n';
  const plan = planConfigInstall({ json, jsonc: '' });
  assert.equal(plan.action, 'manual');
});

test('REQUIRED 5 (f) — top-level plugin: conflict in opencode.jsonc alone (json absent) -> manual, independent of mcp and of the .json check', () => {
  const jsonc = '{\n  "plugin": ["some-other-plugin.mjs"]\n}\n';
  const plan = planConfigInstall({ json: '', jsonc });
  assert.equal(plan.action, 'manual');
});

test('mcp: conflicts but plugin: does not -> still manual (either key alone is sufficient)', () => {
  const json = '{ "mcp": { "filesystem": {} } }';
  assert.equal(planConfigInstall({ json }).action, 'manual');
});

test('plugin: conflicts but mcp: does not -> still manual (either key alone is sufficient)', () => {
  const json = '{ "plugin": ["x.mjs"] }';
  assert.equal(planConfigInstall({ json }).action, 'manual');
});

test('both mcp: and plugin: conflict simultaneously -> manual, reason mentions both', () => {
  const json = '{ "mcp": { "filesystem": {} }, "plugin": ["x.mjs"] }';
  const plan = planConfigInstall({ json });
  assert.equal(plan.action, 'manual');
  assert.match(plan.reason, /mcp/);
  assert.match(plan.reason, /plugin/);
});

test('a "plugin" key nested INSIDE another object is not a top-level conflict', () => {
  const cfg = '{\n  "wrapper": { "plugin": ["fake.mjs"] }\n}\n';
  assert.equal(planConfigInstall({ json: cfg }).action, 'append');
});

test('REQUIRED 4b — conflict lives in opencode.json; opencode.jsonc is clean -> still manual (scans BOTH, not just the append target)', () => {
  const json = '{ "mcp": { "filesystem": {} } }';
  const jsonc = '{ "theme": "dark" }';
  assert.equal(planConfigInstall({ json, jsonc }).action, 'manual');
  // and the mirror direction
  assert.equal(planConfigInstall({ json: jsonc, jsonc: json }).action, 'manual');
});

test('a "mcp" key nested INSIDE another object is not a top-level conflict', () => {
  const cfg = '{\n  "wrapper": { "mcp": { "fake": true } }\n}\n';
  const plan = planConfigInstall({ json: cfg });
  assert.equal(plan.action, 'append');
});

test('REQUIRED 7 — malformed/unparseable config bails to manual, never blind-inserts', () => {
  const cases = [
    '{ "unterminated": "string',
    '{ "unterminated": ',
    '{ "a": 1 } { "b": 2 }', // trailing content after the top-level close
    '[1, 2, 3]', // valid JSON, but not a single top-level object
    '{ "a": 1 ]', // mismatched bracket
    'not json at all',
    '{ "a": 1',           // never closed
    '{ /* unterminated block comment',
  ];
  for (const cfg of cases) {
    const plan = planConfigInstall({ json: cfg });
    assert.equal(plan.action, 'manual', `expected manual for: ${JSON.stringify(cfg)}`);
  }
});

test('REQUIRED 7 — malformed opencode.jsonc alone (json clean) still bails to manual', () => {
  const json = '{ "theme": "dark" }';
  const jsonc = '{ this is not valid json(c)';
  assert.equal(planConfigInstall({ json, jsonc }).action, 'manual');
});

test('when both opencode.json and opencode.jsonc exist and are clean, prefers opencode.json as the append target', () => {
  const json = '{ "theme": "dark" }';
  const jsonc = '{ "other": true }';
  const plan = planConfigInstall({ json, jsonc });
  assert.equal(plan.action, 'append');
  assert.equal(plan.target, 'json');
});

test('only opencode.jsonc exists (no opencode.json) -> appends into jsonc', () => {
  const jsonc = '{ "other": true }';
  const plan = planConfigInstall({ json: '', jsonc });
  assert.equal(plan.action, 'append');
  assert.equal(plan.target, 'jsonc');
});

// ---------------------------------------------------------------------------
// analyzeJsonc — the tokenizer/scanner directly
// ---------------------------------------------------------------------------

test('analyzeJsonc: empty object {} is valid, empty, no comma needed', () => {
  const a = analyzeJsonc('{}');
  assert.equal(a.valid, true);
  assert.equal(a.needsComma, false);
  assert.equal(a.topLevelKeys.size, 0);
});

test('analyzeJsonc: object with only comments inside is treated as empty', () => {
  const a = analyzeJsonc('{ /* nothing here */ }');
  assert.equal(a.valid, true);
  assert.equal(a.needsComma, false);
});

test('analyzeJsonc: trailing comma already present -> needsComma is false (no double comma)', () => {
  const a = analyzeJsonc('{\n  "a": 1,\n}\n');
  assert.equal(a.valid, true);
  assert.equal(a.needsComma, false);
});

test('analyzeJsonc: trailing comma followed by a comment before close -> still no double comma', () => {
  const a = analyzeJsonc('{\n  "a": 1, // trailing comment\n}\n');
  assert.equal(a.valid, true);
  assert.equal(a.needsComma, false);
});

test('analyzeJsonc: non-empty object without trailing comma -> needsComma true', () => {
  const a = analyzeJsonc('{ "a": 1 }');
  assert.equal(a.valid, true);
  assert.equal(a.needsComma, true);
});

// ---------------------------------------------------------------------------
// REQUIRED 3 — brace-insertion against a realistic, non-trivial config
// ---------------------------------------------------------------------------

test('REQUIRED 3 — insertion lands INSIDE the top-level object of a realistic config (nested objects, array as last value, trailing comment)', () => {
  const cfg = `{
  "model": { "provider": "anthropic", "name": "claude" },
  "permission": { "bash": "ask", "edit": "allow" },
  "list": [1, 2, 3]
  // trailing comment right before the close
}
`;
  const plan = planConfigInstall({ json: cfg });
  assert.equal(plan.action, 'append');
  const merged = insertBlock(cfg, plan.insertOffset, plan.needsComma);

  // Original content survives untouched, in order.
  assert.match(merged, /"provider": "anthropic"/);
  assert.match(merged, /"list": \[1, 2, 3\]/);
  assert.match(merged, /\/\/ trailing comment right before the close/);

  // The new block is inside the SAME top-level object: exactly one '{' / one matching final '}'.
  const stripped = stripJsoncComments(merged);
  const parsed = JSON.parse(stripped);
  assert.deepEqual(parsed.mcp, { ours: { type: 'local', command: ['ours-mcp', 'proxy'], enabled: true } });
  assert.ok(Array.isArray(parsed.plugin) && parsed.plugin.length === 1, 'plugin key present as a one-element array');
  assert.deepEqual(parsed.list, [1, 2, 3]);
  assert.equal(parsed.model.provider, 'anthropic');

  // Re-analyzing the merged text still finds exactly one well-formed top-level object.
  const reanalyzed = analyzeJsonc(merged);
  assert.equal(reanalyzed.valid, true);
  assert.ok(reanalyzed.topLevelKeys.has('mcp'));
  assert.ok(reanalyzed.topLevelKeys.has('plugin'));
  assert.ok(reanalyzed.topLevelKeys.has('model'));
  assert.ok(reanalyzed.topLevelKeys.has('list'));
});

// ---------------------------------------------------------------------------
// REQUIRED 5 — //-comments and trailing commas survive BYTE-IDENTICAL
// ---------------------------------------------------------------------------

test('REQUIRED 5 — comments and a trailing comma survive byte-identical; merge is a pure insertion', () => {
  const before = `{
  // a leading comment nobody should touch
  "theme": "dark",
  "keep": ["me", "as-is",],
}
`;
  const plan = planConfigInstall({ json: before });
  assert.equal(plan.action, 'append');
  const merged = insertBlock(before, plan.insertOffset, plan.needsComma);

  // Byte-identical proof by construction: merged must be exactly
  // before[0:offset] + inserted-text + before[offset:], nothing else changed.
  const prefix = before.slice(0, plan.insertOffset);
  const suffix = before.slice(plan.insertOffset);
  assert.equal(merged.slice(0, prefix.length), prefix, 'text before the insertion point is untouched');
  assert.equal(merged.slice(merged.length - suffix.length), suffix, 'text from the insertion point onward (the original close-brace tail) is untouched');
  assert.equal(merged.length, before.length + (merged.length - before.length), 'sanity: merged is strictly before + inserted text');

  // The comment and trailing comma literally still appear verbatim. Note: standard
  // JSON.parse rejects trailing commas even after stripping comments (they're a JSONC/JSON5
  // extension some parsers tolerate) — that's exactly why this planner never re-serializes
  // through a parser and only ever inserts text: round-tripping would have silently dropped
  // this trailing comma. The tokenizer/planner still handled the file fine (plan.action
  // above is 'append', not 'manual'), proving OUR scanner tolerates it even though a strict
  // JSON.parse can't.
  assert.ok(merged.includes('// a leading comment nobody should touch'));
  assert.ok(merged.includes('["me", "as-is",]'));
  assert.throws(() => JSON.parse(stripJsoncComments(before)), SyntaxError, 'sanity: the fixture itself is intentionally not strict-JSON-parseable');
});

test('REQUIRED 5b — a file with comments but no trailing comma survives byte-identical AND remains JSON.parse-able', () => {
  const before = `{
  // a leading comment nobody should touch
  "theme": "dark",
  "keep": ["me", "as-is"]
}
`;
  const plan = planConfigInstall({ json: before });
  assert.equal(plan.action, 'append');
  const merged = insertBlock(before, plan.insertOffset, plan.needsComma);

  const prefix = before.slice(0, plan.insertOffset);
  const suffix = before.slice(plan.insertOffset);
  assert.equal(merged.slice(0, prefix.length), prefix);
  assert.equal(merged.slice(merged.length - suffix.length), suffix);
  assert.ok(merged.includes('// a leading comment nobody should touch'));

  const parsed = JSON.parse(stripJsoncComments(merged));
  assert.deepEqual(parsed.keep, ['me', 'as-is']);
  assert.equal(parsed.theme, 'dark');
  assertOursShape(parsed.mcp);
});

// ---------------------------------------------------------------------------
// REQUIRED — sentinel-present is an UPGRADE, not a blind noop. A stale managed block
// (pre-dating the `plugin` key) must be brought current on re-run, or the ours-monitor plugin
// silently never loads for anyone re-running install.sh over an older install.
// ---------------------------------------------------------------------------

// A stale managed block: our real sentinel/end markers, but body content from BEFORE the
// `plugin` key existed — exactly what an older install's opencode.json/.jsonc would contain.
function staleMcpOnlyBlock() {
  return `${SENTINEL}
// Added by @ours.network/opencode install.sh. Remove this whole block to uninstall.
"mcp": {
  "ours": {
    "type": "local",
    "command": ["ours-mcp", "proxy"],
    "enabled": true
  }
}
${SENTINEL_END}`;
}

test('REQUIRED — a stale mcp-only block (no plugin key) is REPLACED in place with the current block, not duplicated, content outside untouched', () => {
  const before = `{\n  "theme": "dark",\n  ${staleMcpOnlyBlock().split('\n').join('\n  ')}\n}\n`;
  const plan = planConfigInstall({ json: before });
  assert.equal(plan.action, 'upgrade');
  assert.equal(plan.target, 'json');

  const result = upgradeBlock(before, plan.span, withPlugin);
  assert.equal(result.changed, true, 'a stale block is NOT already current -> must be replaced, not a noop');

  // Exactly one sentinel pair — not duplicated.
  assert.equal((result.text.match(new RegExp(SENTINEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 1);
  // Content strictly outside the managed span survives untouched.
  assert.match(result.text, /"theme": "dark"/);
  // The upgraded block now carries the plugin key the stale block never had.
  assert.match(result.text, /"plugin":/);

  const parsed = JSON.parse(stripJsoncComments(result.text));
  assert.equal(parsed.theme, 'dark');
  assertOursShape(parsed.mcp);
  assertPluginShape(parsed.plugin, TEST_PLUGIN_PATH);
  assert.equal(analyzeJsonc(result.text).valid, true, 'still a single well-formed top-level object after the upgrade');
});

test('REQUIRED — a block that already matches the current render is a TRUE noop (no rewrite, byte-identical)', () => {
  // Build a file the same way install.sh's OWN fresh-install path would: render the CURRENT
  // block for real, so "already current" means something, not just a hand-copied fixture.
  const plan0 = planConfigInstall({});
  assert.equal(plan0.action, 'write');
  const before = renderFreshConfig(withPlugin);

  const plan = planConfigInstall({ json: before });
  assert.equal(plan.action, 'upgrade', 'sentinel present -> still routed through upgrade, even though nothing will change');
  const result = upgradeBlock(before, plan.span, withPlugin);
  assert.equal(result.changed, false, 're-running with the SAME pluginPath against an already-current block changes nothing');
  assert.equal(result.text, before, 'byte-identical: a true noop, not a rewrite that happens to look the same');
});

test('REQUIRED — the upgrade path works identically when the block lives in opencode.jsonc instead of opencode.json', () => {
  const before = `{\n  "theme": "dark",\n  ${staleMcpOnlyBlock().split('\n').join('\n  ')}\n}\n`;
  const plan = planConfigInstall({ json: '', jsonc: before });
  assert.equal(plan.action, 'upgrade');
  assert.equal(plan.target, 'jsonc');

  const result = upgradeBlock(before, plan.span, withPlugin);
  assert.equal(result.changed, true);
  const parsed = JSON.parse(stripJsoncComments(result.text));
  assert.equal(parsed.theme, 'dark');
  assertPluginShape(parsed.plugin, TEST_PLUGIN_PATH);
});

test('REQUIRED — a file with our sentinel but otherwise broken JSON(C) still bails to manual, never spliced', () => {
  const before = `{\n  "theme": "dark"\n  ${staleMcpOnlyBlock().split('\n').join('\n  ')}\n`; // missing closing '}'
  const plan = planConfigInstall({ json: before });
  assert.equal(plan.action, 'manual');
});

test('findManagedBlockSpan: returns null when there is no sentinel at all, or when the end marker is missing', () => {
  assert.equal(findManagedBlockSpan('{ "a": 1 }'), null);
  assert.equal(findManagedBlockSpan(`{ ${SENTINEL} "mcp": {} }`), null); // no SENTINEL_END
});

// ---------------------------------------------------------------------------
// Extra bar — the rendered mcp block (and full merged/fresh output) must itself
// be schema-valid, so opencode never hard-fails on OUR write.
// ---------------------------------------------------------------------------

function assertOursShape(mcp) {
  assert.deepEqual(mcp.ours, { type: 'local', command: ['ours-mcp', 'proxy'], enabled: true });
  assert.equal(typeof mcp.ours.type, 'string');
  assert.ok(Array.isArray(mcp.ours.command));
  assert.ok(mcp.ours.command.every((c) => typeof c === 'string'));
  assert.equal(typeof mcp.ours.enabled, 'boolean');
}

function assertPluginShape(pluginField, expectedPath) {
  assert.ok(Array.isArray(pluginField));
  assert.equal(pluginField.length, 1);
  assert.equal(typeof pluginField[0], 'string');
  if (expectedPath) assert.equal(pluginField[0], expectedPath);
}

test('rendered block alone is schema-valid JSON(C): wraps to a parseable object with the right mcp.ours + plugin shape', () => {
  const wrapped = `{\n${renderConfigBlock(withPlugin)}\n}`;
  const parsed = JSON.parse(stripJsoncComments(wrapped));
  assertOursShape(parsed.mcp);
  assertPluginShape(parsed.plugin, TEST_PLUGIN_PATH);
});

test('renderConfigBlock() with no pluginPath option falls back to defaultPluginPath()', () => {
  const wrapped = `{\n${renderConfigBlock()}\n}`;
  const parsed = JSON.parse(stripJsoncComments(wrapped));
  assertPluginShape(parsed.plugin, defaultPluginPath());
});

test('renderFreshConfig() output is schema-valid JSON(C) with $schema + mcp.ours + plugin', () => {
  const fresh = renderFreshConfig(withPlugin);
  const parsed = JSON.parse(stripJsoncComments(fresh));
  assert.equal(parsed.$schema, 'https://opencode.ai/config.json');
  assertOursShape(parsed.mcp);
  assertPluginShape(parsed.plugin, TEST_PLUGIN_PATH);
  // and the plan/analysis pipeline agrees it's well-formed
  const a = analyzeJsonc(fresh);
  assert.equal(a.valid, true);
  assert.ok(a.topLevelKeys.has('mcp'));
  assert.ok(a.topLevelKeys.has('plugin'));
  assert.ok(a.topLevelKeys.has('$schema'));
});

test('appending into an empty-object config {} produces schema-valid output with both keys', () => {
  const plan = planConfigInstall({ json: '{}' });
  assert.equal(plan.action, 'append');
  assert.equal(plan.needsComma, false);
  const merged = insertBlock('{}', plan.insertOffset, plan.needsComma, withPlugin);
  const parsed = JSON.parse(stripJsoncComments(merged));
  assertOursShape(parsed.mcp);
  assertPluginShape(parsed.plugin, TEST_PLUGIN_PATH);
});

test('a pluginPath containing characters needing JSON escaping is embedded safely', () => {
  const trickyPath = 'C:\\Users\\weird "name"\\opencode\\plugin\\ours-monitor.mjs';
  const wrapped = `{\n${renderConfigBlock({ pluginPath: trickyPath })}\n}`;
  const parsed = JSON.parse(stripJsoncComments(wrapped));
  assertPluginShape(parsed.plugin, trickyPath);
});

test('rendered block carries a schema-version comment (so a future opencode schema break is legible)', () => {
  const block = renderConfigBlock(withPlugin);
  assert.match(block, /schema/i);
  assert.match(block, /unreleased/i);
});
