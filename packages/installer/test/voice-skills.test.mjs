import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packages = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

for (const platform of ['claude-code', 'codex', 'hermes']) {
  test(`${platform} shipped skill teaches safe voice setup and Telegram fallback`, () => {
    const skill = readFileSync(join(packages, platform, 'skills/ours/SKILL.md'), 'utf8');
    const ref = readFileSync(join(packages, platform, 'skills/ours/references/configuration.md'), 'utf8');
    assert.match(skill, /ours-mcp voice-status --json/);
    assert.match(skill, /Never ask for, paste, echo, or put the key in chat\/tool arguments/);
    assert.match(ref, /ours-install/);
    assert.match(ref, /mode\s+`0600`/);
    assert.match(ref, /audio\/ogg; x-ours-kind=voice-message/);
    assert.match(ref, /OGG\/Opus bytes/);
    assert.match(ref, /attachment\.wire_id/);
    assert.match(ref, /provider responses are\s+scrubbed/);
  });
}
