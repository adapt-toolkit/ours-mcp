import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// A relocated entrypoint must still enforce the selected daemon and stream files.
test('package entrypoint preserves target validation and private file roundtrip', () => {
  const state = mkdtempSync(join(tmpdir(), 'ours-container-'));
  const expected = randomUUID();
  const entry = new URL('../dist/container.js', import.meta.url);
  const run = (command, args = [], input, id = expected) => spawnSync(process.execPath,
    [entry.pathname, id, command, ...args], {
      env: { ...process.env, OURS_CONFIG: join(state, '.mcp/profile.json'), OURS_MCP_CONFIG: join(state, '.mcp/config.json'), OURS_STATE_DIR: undefined, OURS_DAEMON_ID: undefined },
      input, encoding: 'utf8', timeout: 5000,
    });
  try {
    mkdirSync(join(state, '.mcp'), { mode: 0o700 });
    writeFileSync(join(state, '.mcp/profile.json'), JSON.stringify({serverUrl:'http://gateway.test', expectedInstanceId: expected, credentialPath:join(state,'credential')}), { mode: 0o600 });
    const id = randomUUID();
    const staged = run('file-stage', [id, 'input.bin'], 'bytes\u0000\n');
    assert.equal(staged.status, 0, staged.stderr);
    const path = JSON.parse(staged.stdout).path;
    assert.equal(readFileSync(path, 'utf8'), 'bytes\u0000\n');
    const targetId = randomUUID();
    const target = run('file-target', [targetId]);
    assert.equal(target.status, 0, target.stderr);
    writeFileSync(JSON.parse(target.stdout).path, 'received\u0000\n');
    const received = run('file-read', [targetId]);
    assert.equal(received.status, 0, received.stderr);
    assert.equal(received.stdout, 'received\u0000\n');
    assert.equal(run('file-remove', [id]).status, 0);
    assert.equal(existsSync(path), false);
    assert.notEqual(run('file-target', ['../outside']).status, 0);
    assert.notEqual(run('file-stage', [randomUUID(), '../outside'], 'bad').status, 0);
    assert.match(run('file-target', [randomUUID()], undefined, randomUUID()).stderr, /target does not match/);
    writeFileSync(join(state, '.mcp/profile.json'), JSON.stringify({serverUrl:'http://gateway.test', expectedInstanceId: randomUUID(), credentialPath:join(state,'credential')}));
    assert.match(run('file-target', [randomUUID()]).stderr, /target does not match/);
  } finally { rmSync(state, { recursive: true, force: true }); }
});
