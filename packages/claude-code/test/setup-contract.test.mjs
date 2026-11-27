import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
test('shipped skill uses installer local acquisition and separates plugin and executable', () => {
  const skill = readFileSync(new URL('../skills/ours/SKILL.md', import.meta.url), 'utf8');
  assert.doesNotMatch(skill, /\/plugin marketplace add adapt-toolkit\/ours-claude-marketplace/);
  assert.match(skill, /ours-install --plugin-only/);
  assert.match(skill, /ours-install client .*--integrations claude-code/);
  assert.match(skill, /not the upstream Anthropic Claude Code executable/);
});
