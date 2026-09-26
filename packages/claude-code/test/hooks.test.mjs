import { renderIdentityDirective } from '../dist/hooks/runner.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('workspace pin advice does not classify existence or authorize actions', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ours-claude-pin-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = join(root, 'state');
  mkdirSync(state);
  writeFileSync(join(root, '.ours-identity'), JSON.stringify({ identity: 'Pinned', expose_local: false }));
  const env = { ...process.env, HOME: root, OURS_STATE_DIR: state };
  for (const key of Object.keys(env)) {
    if (key.startsWith('OURS_') && key !== 'OURS_STATE_DIR') delete env[key];
  }
  const run = (kind, payload = {}) => JSON.parse(execFileSync(process.execPath, [
    fileURLToPath(new URL('../dist/hooks/runner.js', import.meta.url)), kind,
  ], { env, cwd: root, input: JSON.stringify({ cwd: root, ...payload }), encoding: 'utf8' }));
  const before = renderIdentityDirective({ identity:'Pinned', expose_local:false });
  assert.equal(run('session-start').hookSpecificOutput, undefined, 'missing gateway fails closed');
  mkdirSync(join(state, 'Pinned'));
  const after = renderIdentityDirective({ identity:'Pinned', expose_local:false });
  assert.equal(before, after, 'a local directory is not an authority for identity existence');
  assert.match(after, /suggestion, not an authorization/);
  assert.match(after, /daemon tools/);
  assert.doesNotMatch(after, /does not exist|call `create_identity|call `choose_identity/);
  assert.match(after, /explicitly confirm/);
  assert.match(after, /persona.*do NOT adopt/s);
  assert.match(after, /only pass force=true after they confirm/);
  assert.equal(run('user-prompt-submit').hookSpecificOutput, undefined);
  assert.equal(run('session-start', { source: 'compact' }).hookSpecificOutput, undefined);
  writeFileSync(join(state, 'bindings.json'), JSON.stringify({ pid: process.pid, bound: ['Other'] }));
  assert.equal(run('user-prompt-submit').hookSpecificOutput, undefined,
    'the existing live-binding reminder suppression is retained');
});
