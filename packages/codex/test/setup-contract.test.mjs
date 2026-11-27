import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
test('Codex README and shipped skill agree on the verified installer marketplace',()=>{
 for(const path of ['../README.md','../skills/ours/SKILL.md']) {
 const text=readFileSync(new URL(path,import.meta.url),'utf8');
 assert.match(text,/ours-install --plugin-only/);
 assert.match(text,/ours-install client .*--integrations codex/);
 assert.doesNotMatch(text,/plugin marketplace add adapt-toolkit\/ours-codex-marketplace/);
 assert.doesNotMatch(text,/Install the native plugin from the ours Codex marketplace/);
 }
});
