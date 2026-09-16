import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const manifests = [
  ...['core', 'claude-code', 'hermes', 'codex', 'installer'].map(p => `packages/${p}/package.json`),
  'packages/claude-code/.claude-plugin/plugin.json',
  'packages/codex/.codex-plugin/plugin.json',
];

for (const mode of ['stable', 'nightly', 'promote']) {
  test(`${mode} release preserves standalone plugin dependencies`, () => {
    const temp = mkdtempSync(join(tmpdir(), 'ours-bump-test-'));
    try {
      const bin = join(temp, 'bin');
      const home = join(temp, 'home');
      mkdirSync(bin); mkdirSync(home);
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        !key.startsWith('OURS_') && !key.startsWith('GIT_') && !key.startsWith('GITHUB_')
        && !key.toLowerCase().startsWith('npm_config_')));
      Object.assign(env, { HOME: home, PATH: `${bin}:${env.PATH}`, GIT_CONFIG_NOSYSTEM: '1',
        OURS_BUMP_DRY_RUN: '1', OURS_RELEASE_MODE: mode });
      // No network or lifecycle scripts: only the exact npm operations the bump needs.
      writeFileSync(join(bin, 'npm'), `#!/bin/sh
case "$1:$3" in
  view:version) echo 0.0.0 ;;
  view:versions) echo '[]' ;;
  install:--ignore-scripts) test "$2" = --package-lock-only ;;
  *) echo "unexpected npm invocation" >&2; exit 90 ;;
esac
`, { mode: 0o755 });
      const before = new Map();
      for (const file of manifests) {
        mkdirSync(dirname(join(temp, file)), { recursive: true });
        cpSync(join(root, file), join(temp, file));
        before.set(file, JSON.parse(readFileSync(join(temp, file))));
      }
      cpSync(join(root, '.github/workflows/scripts/bump-versions.sh'), join(temp, 'bump.sh'));
      writeFileSync(join(temp, 'package-lock.json'), '{"fixture":true}\n');
      function run(command, args) {
        const r = spawnSync(command, args, { cwd: temp, env, encoding: 'utf8', timeout: 30_000 });
        assert.equal(r.status, 0, `${command}: ${r.error ?? ''}\n${r.stdout}\n${r.stderr}`);
        return r.stdout.trim();
      }
      run('git', ['init', '-q']);
      run('git', ['add', '.']);
      run('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fix: release fixture']);
      const head = run('git', ['rev-parse', 'HEAD']);
      run('bash', ['bump.sh']);
      const versions = new Set();
      for (const file of manifests) {
        const after = JSON.parse(readFileSync(join(temp, file)));
        versions.add(after.version);
        assert.notEqual(after.version, before.get(file).version);
        assert.deepEqual(after.dependencies, before.get(file).dependencies, `${file}: dependency graph changed`);
      }
      assert.equal(versions.size, 1);
      assert.equal([...versions][0].includes('-nightly.'), mode === 'nightly');
      assert.equal(run('git', ['rev-parse', 'HEAD']), head, 'dry-run must not commit');
      assert.equal(readFileSync(join(temp, 'package-lock.json'), 'utf8'), '{"fixture":true}\n');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
}
