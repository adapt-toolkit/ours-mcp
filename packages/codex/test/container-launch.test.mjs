import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

for (const plugin of ['codex', 'claude-code']) {
  test(`${plugin} routes native proxy and SessionEnd bytes exclusively through selected Docker`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'ours-container-launch-'));
    try {
      const profile = join(dir, 'profile.json');
      const record = join(dir, 'invocation.json');
      writeFileSync(profile, JSON.stringify({ endpoint: 'http://localhost:3050', expectedInstanceId: 'test-daemon', credentialPath: '/private/token', composeFile: '/private/compose file.yml', composeProject: 'selected' }));
      writeFileSync(join(dir, 'docker'), `#!${process.execPath}\nimport fs from 'node:fs'; fs.writeFileSync(process.env.RECORD, JSON.stringify({args:process.argv.slice(2), id:process.env.OURS_DAEMON_ID})); process.stdin.pipe(process.stdout);`);
      chmodSync(join(dir, 'docker'), 0o755);
      const env = { ...process.env, PATH: dir, RECORD: record, OURS_CONFIG: profile, CLAUDE_CODE_SESSION_ID: 'session=value', OURS_BIND_IDENTITY: 'alice', OURS_DAEMON_ID: 'wrong' };
      for (const command of ['proxy', 'session-end']) {
        const input = Buffer.from('{ "session_id": "native" }\n\u0000\u00ff');
        const result = spawnSync(process.execPath, [fileURLToPath(new URL(`../../${plugin}/bin/proxy.mjs`, import.meta.url)), ...(command === 'proxy' ? [] : command === 'watch' ? ['watch', 'alice'] : [command])], { env, input });
        assert.equal(result.status, 0, result.stderr.toString());
        assert.deepEqual(result.stdout, input);
        assert.deepEqual(JSON.parse(readFileSync(record, 'utf8')), { args: ['compose', '-f', '/private/compose file.yml', '-p', 'selected', 'exec', '-T', '-e', 'CLAUDE_CODE_SESSION_ID=session=value', '-e', 'OURS_BIND_IDENTITY=alice', 'daemon', 'node', '/opt/ours/node_modules/@ours.network/mcp/dist/container.js', 'test-daemon', command, ...(command === 'watch' ? ['alice'] : [])], id: 'test-daemon' });
      }
      writeFileSync(join(dir, 'docker'), `#!${process.execPath}\nprocess.exit(47);`);
      const failure = spawnSync(process.execPath, [fileURLToPath(new URL(`../../${plugin}/bin/proxy.mjs`, import.meta.url))], { env });
      assert.equal(failure.status, 47);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test('Claude container hooks surface selected remote unread and preserve local workspace pins', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ours-container-hook-'));
  try {
    const profile = join(dir, 'profile.json');
    writeFileSync(profile, JSON.stringify({ expectedInstanceId: 'daemon', composeFile: '/compose.yml' }));
    writeFileSync(join(dir, '.ours-identity'), JSON.stringify({ identity: 'remote' }));
    writeFileSync(join(dir, 'docker'), `#!${process.execPath}\nconsole.log(JSON.stringify({identities:['remote'], unread:{identities:[{name:'remote',count:2,recent:[]}]},bindings:process.env.TEST_BOUND ? ['remote'] : []}));`);
    chmodSync(join(dir, 'docker'), 0o755);
    const env = { ...process.env, PATH: dir, OURS_CONFIG: profile };
    const runner = fileURLToPath(new URL('../../claude-code/src/hooks/runner.ts', import.meta.url));
    const run = (kind, extra = {}) => spawnSync(process.execPath, [runner, kind], { env: { ...env, ...extra }, input: JSON.stringify({ cwd: dir }), encoding: 'utf8' });
    const start = run('session-start');
    assert.equal(start.status, 0, start.stderr);
    const context = JSON.parse(start.stdout).hookSpecificOutput?.additionalContext || '';
    assert.match(context, /remote — 2 unread/);
    assert.match(context, /choose_identity/);
    assert.match(context, /bin\/proxy\.mjs.*watch/);
    assert.doesNotMatch(context, /ours-mcp watch/);
    assert.doesNotMatch(context, /does not exist/);
    assert.deepEqual(JSON.parse(run('user-prompt-submit', { TEST_BOUND: '1' }).stdout), { continue: true });
    writeFileSync(join(dir, 'docker'), `#!${process.execPath}\nprocess.exit(1);`);
    assert.deepEqual(JSON.parse(run('session-start').stdout), { continue: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const plugin of ['codex', 'claude-code']) {
  test(`${plugin} container selection validates profile and isolates Compose UUID from exec environment`, async () => {
    const { containerInvocation, readContainerJson } = await import(`../../${plugin}/bin/container-launch.mjs`);
    const dir = mkdtempSync(join(tmpdir(), 'ours-container-selection-'));
    try {
      const path = join(dir, 'profile.json');
      const env = { OURS_CONFIG: path, OURS_DAEMON_ID: 'unrelated', OURS_API_TOKEN: 'host-secret' };
      writeFileSync(path, '{}');
      assert.equal(containerInvocation('watch', ['alice'], env), null);
      writeFileSync(path, JSON.stringify({ composeFile: 'relative.yml', expectedInstanceId: 'selected' }));
      assert.throws(() => containerInvocation('watch', ['alice'], env), /absolute path/);
      writeFileSync(path, JSON.stringify({ composeFile: '/compose.yml' }));
      assert.throws(() => containerInvocation('watch', ['alice'], env), /expectedInstanceId/);
      writeFileSync(path, JSON.stringify({ composeFile: '/compose.yml', expectedInstanceId: 'selected' }));
      const invocation = containerInvocation('watch', ['alice'], env);
      assert.deepEqual(invocation.args, ['compose', '-f', '/compose.yml', 'exec', '-T', 'daemon', 'node', '/opt/ours/node_modules/@ours.network/mcp/dist/container.js', 'selected', 'watch', 'alice']);
      assert.equal(invocation.env.OURS_DAEMON_ID, 'selected');
      assert.equal(env.OURS_DAEMON_ID, 'unrelated');
      assert.throws(() => readContainerJson('application-identities', { ...env, PATH: dir }), /ENOENT/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

for (const plugin of ['codex', 'claude-code']) {
  test(`${plugin} unreadable or corrupt explicit profile cannot select a host MCP`, async () => {
    const { containerInvocation } = await import(`../../${plugin}/bin/container-launch.mjs`);
    const dir = mkdtempSync(join(tmpdir(), 'ours-container-corrupt-'));
    try {
      const profile = join(dir, 'profile.json');
      assert.throws(() => containerInvocation('proxy', [], { OURS_CONFIG: profile }), /profile/);
      writeFileSync(profile, '{"composeFile":');
      assert.throws(() => containerInvocation('proxy', [], { OURS_CONFIG: profile }), /profile/);
      const result = spawnSync(process.execPath, [fileURLToPath(new URL(`../../${plugin}/bin/proxy.mjs`, import.meta.url))], { env: { ...process.env, PATH: dir, OURS_CONFIG: profile }, encoding: 'utf8' });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /cannot read OURS_CONFIG profile/);
      assert.doesNotMatch(result.stderr, /cannot resolve|spawn ours-mcp/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}


test('Claude container watch keeps stdin open until the shim is stopped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ours-claude-watch-'));
  let child;
  try {
    const profile = join(dir, 'profile.json');
    const ended = join(dir, 'ended');
    writeFileSync(profile, JSON.stringify({ composeFile: '/compose.yml', expectedInstanceId: 'selected' }));
    writeFileSync(join(dir, 'docker'), `#!${process.execPath}
if (process.argv.slice(-3).join(',') !== 'selected,watch,alice') process.exit(5);
import fs from 'node:fs'; process.on('SIGTERM', () => {}); process.stdin.resume(); process.stdin.on('end', () => { fs.writeFileSync(process.env.ENDED, 'EOF'); process.exit(0); }); console.log('ready');`);
    chmodSync(join(dir, 'docker'), 0o755);
    child = spawn(process.execPath, [fileURLToPath(new URL('../../claude-code/bin/proxy.mjs', import.meta.url)), 'watch', 'alice'], { env: { ...process.env, PATH: dir, OURS_CONFIG: profile, ENDED: ended }, stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = new Promise((resolve) => child.once('exit', resolve));
    await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', (code) => reject(new Error(`watch exited ${code}`))); });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(existsSync(ended), false, 'outer stdin EOF must not stop the watch');
    child.kill('SIGTERM');
    await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('watch stop timed out')), 3000).unref())]);
    assert.equal(readFileSync(ended, 'utf8'), 'EOF');
  } finally { child?.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); }
});
