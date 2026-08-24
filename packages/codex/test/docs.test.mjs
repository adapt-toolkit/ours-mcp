import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const docs = ['README.md', 'AGENTS.snippet.md', 'skills/ours/SKILL.md', 'skills/ours/references/configuration.md'].map((p) => readFileSync(join(root, p), 'utf8')).join('\n');

test('Codex docs describe native plugin standard/live modes and consent', () => {
  for (const pattern of [/standard mode/i, /live mode/i, /ours-codex/, /explicit.*arm/i, /foreground_monitor/, /blocking foreground/i, /ours-codex` provides background\s+monitoring/i, /never omit/i, /stops?.*session/i, /SessionStart/, /marketplace/i, /--ours-port/, /OURS_CONFIG/, /hooks?/i]) assert.match(docs, pattern);
});

test('Codex docs contain no obsolete Claude or polling claims', () => {
  for (const pattern of [/Monitor\(\{/, /TaskStop/, /Codex has no SessionStart hook/i, /blocking `ours-mcp watch/i, /polls? `get_messages` every ~?5s/i, /host-wide singleton/i, /daemon is a singleton/i]) assert.doesNotMatch(docs, pattern);
});

test('Codex docs describe the shared-daemon boundary', () => {
  for (const pattern of [/ours daemon status/, /ours config setup/, /never starts a daemon/i, /coherent selection/i]) assert.match(docs, pattern);
  assert.doesNotMatch(docs, /ours-mcp voice-status|installer-profiles\.json/);
});
