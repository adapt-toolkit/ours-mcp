import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const root = mkdtempSync(join(tmpdir(), 'ours-mcp-cli-'));
const fake = join(root, 'ours');
const trace = join(root, 'trace');
writeFileSync(fake, '#!/bin/sh\nprintf "%s\\n" "$@" > "$OURS_TEST_TRACE"\nprintf "delegated stdout\\n"\nprintf "delegated stderr\\n" >&2\nexit 23\n');
chmodSync(fake, 0o755);

const cli = new URL('../dist/cli.js', import.meta.url);
const result = spawnSync(process.execPath, [cli.pathname, 'status', '--json'], {
  encoding: 'utf8',
  env: { ...process.env, OURS_CLI: fake, OURS_TEST_TRACE: trace },
});
assert.equal(result.status, 23, 'delegated CLI exit status is preserved');
assert.equal(result.stdout, 'delegated stdout\n');
assert.equal(result.stderr, 'delegated stderr\n');
assert.equal(readFileSync(trace, 'utf8'), 'daemon\nstatus\n--json\n', 'argv is passed without prose parsing');

const missing = spawnSync(process.execPath, [cli.pathname, 'status'], {
  encoding: 'utf8',
  env: { ...process.env, OURS_CLI: join(root, 'missing-ours') },
});
assert.equal(missing.status, 1);
assert.match(missing.stderr, /Install @ours\.network\/cli@1\.0\.1/);
assert.match(missing.stderr, /OURS_CLI/);

const legacyApplication = spawnSync(
  process.execPath,
  [cli.pathname, 'proxy', '--application', 'codex'],
  { encoding: 'utf8', env: process.env },
);
assert.equal(legacyApplication.status, 1);
assert.match(legacyApplication.stderr, /--application.*no longer supported/);

const source = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
assert.match(source, /--application.*no longer supported/s, 'obsolete application selection fails with migration guidance');
assert.match(source, /Install @ours\.network\/cli@1\.0\.1/, 'missing delegated CLI reports exact install guidance');

console.log('cli-delegation: all passed');
