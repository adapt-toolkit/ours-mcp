// Upgrade-simulation tests for install.sh: prove that re-running the installer over an OLD
// install is a CLEAN UPGRADE — the daemon is ensured @latest (not skipped) and restarted when the
// version changed, and versions are echoed. Uses fake `npm` + `ours-mcp` bins on PATH so nothing
// global is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));
const INSTALL = join(PKG, 'install.sh');

// Fake `ours-mcp`: version + start/stop/restart/status driven by files under $OURS_FAKE_STATE.
const FAKE_OURS_MCP = `#!/usr/bin/env bash
S="$OURS_FAKE_STATE"; echo "$*" >> "$S/ours-mcp.log"
iv(){ cat "$S/installed_version" 2>/dev/null || echo ""; }
case "\${1:-}" in
  --version|-v|version) echo "ours-mcp v$(iv)"; if [ -f "$S/running" ]; then echo "running daemon: v$(cat "$S/running_version" 2>/dev/null)"; else echo "daemon: not running"; fi ;;
  status) [ -f "$S/running" ] ;;
  start|restart) touch "$S/running"; iv > "$S/running_version" ;;
  stop) rm -f "$S/running" ;;
  *) : ;;
esac
`;

// Fake `npm`: `i -g <pkg>@latest` bumps a version file; `ls -g <pkg>` prints its version.
const FAKE_NPM = `#!/usr/bin/env bash
S="$OURS_FAKE_STATE"; echo "$*" >> "$S/npm.log"
sub="\${1:-}"
if [ "$sub" = i ] || [ "$sub" = install ] || [ "$sub" = add ]; then
  for a in "$@"; do case "$a" in
    @ours.network/mcp@latest|@ours.network/mcp)         echo "\${OURS_FAKE_NEW_MCP:-0.9.9}" > "$S/installed_version" ;;
    @ours.network/opencode@latest|@ours.network/opencode) echo "0.9.9" > "$S/opencode_version" ;;
  esac; done
elif [ "$sub" = ls ]; then
  for a in "$@"; do case "$a" in
    @ours.network/opencode) echo "@ours.network/opencode@$(cat "$S/opencode_version" 2>/dev/null || echo 0.9.9)" ;;
  esac; done
fi
exit 0
`;

function makeEnv(dir) {
  const bin = join(dir, 'bin');
  const state = join(dir, 'state');
  mkdirSync(bin, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(bin, 'ours-mcp'), FAKE_OURS_MCP); chmodSync(join(bin, 'ours-mcp'), 0o755);
  writeFileSync(join(bin, 'npm'), FAKE_NPM); chmodSync(join(bin, 'npm'), 0o755);
  return { bin, state };
}

function run(opencodeDir, dir, { bin, state }, extraEnv = {}) {
  return execFileSync('bash', [INSTALL], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      OURS_FAKE_STATE: state,
      OPENCODE_DIR: opencodeDir,
      ...extraEnv,
    },
  });
}

test('daemon on an OLD running version is ensured @latest and RESTARTED; versions echoed', () => {
  const D = mkdtempSync(join(tmpdir(), 'opencode-up-'));
  try {
    const env = makeEnv(D);
    writeFileSync(join(env.state, 'installed_version'), '0.3.0\n');
    writeFileSync(join(env.state, 'running'), '');
    writeFileSync(join(env.state, 'running_version'), '0.3.0\n');

    const out = run(join(D, '.config/opencode'), D, env);

    const npmLog = readFileSync(join(env.state, 'npm.log'), 'utf8');
    const mcpLog = readFileSync(join(env.state, 'ours-mcp.log'), 'utf8');
    assert.match(npmLog, /i -g @ours\.network\/mcp@latest/, 'daemon ensured @latest');
    assert.equal(readFileSync(join(env.state, 'installed_version'), 'utf8').trim(), '0.9.9', 'daemon upgraded');
    assert.match(mcpLog, /\brestart\b/, 'daemon restarted after a version change');
    assert.doesNotMatch(mcpLog, /\bstart\b/, 'restart used (not start) since it was running');
    assert.match(out, /versions:/, 'version echo present');
    assert.match(out, /daemon: ours-mcp v0\.9\.9/, 'echoes the new daemon version');
    assert.match(out, /plugin: @ours\.network\/opencode@0\.9\.9/, 'echoes the plugin version');
  } finally {
    rmSync(D, { recursive: true, force: true });
  }
});

test('daemon NOT running is ensured @latest and STARTED (not restarted)', () => {
  const D = mkdtempSync(join(tmpdir(), 'opencode-up-'));
  try {
    const env = makeEnv(D);
    writeFileSync(join(env.state, 'installed_version'), '0.3.0\n'); // present but not running
    const out = run(join(D, '.config/opencode'), D, env);
    const mcpLog = readFileSync(join(env.state, 'ours-mcp.log'), 'utf8');
    assert.match(mcpLog, /\bstart\b/, 'daemon started');
    assert.doesNotMatch(mcpLog, /\brestart\b/, 'no restart when it was not running');
    assert.match(out, /daemon: ours-mcp v0\.9\.9/);
  } finally {
    rmSync(D, { recursive: true, force: true });
  }
});

test('daemon already on latest is NOT restarted', () => {
  const D = mkdtempSync(join(tmpdir(), 'opencode-up-'));
  try {
    const env = makeEnv(D);
    writeFileSync(join(env.state, 'installed_version'), '0.9.9\n');
    writeFileSync(join(env.state, 'running'), '');
    writeFileSync(join(env.state, 'running_version'), '0.9.9\n');
    run(join(D, '.config/opencode'), D, env, { OURS_FAKE_NEW_MCP: '0.9.9' });
    const mcpLog = readFileSync(join(env.state, 'ours-mcp.log'), 'utf8');
    assert.doesNotMatch(mcpLog, /\brestart\b/, 'no restart when already latest');
    assert.doesNotMatch(mcpLog, /\bstart\b/, 'no start when already running latest');
  } finally {
    rmSync(D, { recursive: true, force: true });
  }
});

test('OURS_INSTALL_SKIP_DAEMON=1 skips the daemon step entirely (no npm/ours-mcp calls)', () => {
  const D = mkdtempSync(join(tmpdir(), 'opencode-up-'));
  try {
    const env = makeEnv(D);
    const out = run(join(D, '.config/opencode'), D, env, { OURS_INSTALL_SKIP_DAEMON: '1' });
    assert.match(out, /skipping daemon step/);
    assert.ok(!existsSync(join(env.state, 'npm.log')), 'npm never invoked');
    assert.ok(!existsSync(join(env.state, 'ours-mcp.log')), 'ours-mcp never invoked');
  } finally {
    rmSync(D, { recursive: true, force: true });
  }
});

test('re-running after a successful install is a clean no-op upgrade path (skills + config idempotent, daemon still ensured)', () => {
  const D = mkdtempSync(join(tmpdir(), 'opencode-up-'));
  try {
    const env = makeEnv(D);
    const opencodeDir = join(D, '.config/opencode');
    writeFileSync(join(env.state, 'installed_version'), '0.9.9\n');

    run(opencodeDir, D, env, { OURS_FAKE_NEW_MCP: '0.9.9' });
    const cfgAfterFirst = readFileSync(join(opencodeDir, 'opencode.json'), 'utf8');

    run(opencodeDir, D, env, { OURS_FAKE_NEW_MCP: '0.9.9' });
    const cfgAfterSecond = readFileSync(join(opencodeDir, 'opencode.json'), 'utf8');

    assert.equal(cfgAfterFirst, cfgAfterSecond, 'config is byte-identical after a second run');
    assert.equal((cfgAfterSecond.match(/\/\/ >>> ours\.network plugin/g) || []).length, 1);
  } finally {
    rmSync(D, { recursive: true, force: true });
  }
});
