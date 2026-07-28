import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

for (const harness of ['codex', 'claude-code', 'hermes']) {
  test(`${harness} core ours skill discovers and delegates to ours-fleet`, () => {
    const skill = readFileSync(
      join(root, 'packages', harness, 'skills', 'ours', 'SKILL.md'), 'utf8');
    const frontmatter = skill.slice(0, skill.indexOf('---', 4) + 3);
    assert.match(frontmatter, /ours-fleet|fleet agent/i,
      'fleet requests trigger the already-installed core ours skill');
    assert.match(skill, /command -v ours-fleet/,
      'checks whether the fleet CLI is installed');
    assert.match(skill, /npm i -g @ours\.network\/fleet@latest/,
      'can install a missing fleet CLI without asking the user for commands');
    assert.match(skill, /ours-fleet docs/,
      'delegates detailed and version-specific behavior to the installed CLI');
    assert.match(skill, /ours-fleet --help/,
      'falls back gracefully when the installed fleet predates the docs command');
    assert.doesNotMatch(skill, /--session\s+acp|--approval\s+ask/,
      'does not duplicate version-sensitive fleet flags');
  });
}
