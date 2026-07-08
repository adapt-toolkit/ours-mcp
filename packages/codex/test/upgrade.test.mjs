// Upgrade-simulation test for install.sh: the daemon is ensured @latest (not skipped) and
// restarted when the version changed, and versions are echoed. Codex has no connector-era
// artifacts and owns ~/.agents/skills (overwritten fresh), so there is nothing legacy to clean.
// Fake `npm` + `ours-mcp` bins on PATH so nothing global is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));
const INSTALL = join(PKG, 'install.sh');

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
const FAKE_NPM = `#!/usr/bin/env bash
S="$OURS_FAKE_STATE"; echo "$*" >> "$S/npm.log"
sub="\${1:-}"
if [ "$sub" = i ] || [ "$sub" = install ] || [ "$sub" = add ]; then
  for a in "$@"; do case "$a" in
    @ours.network/mcp@latest|@ours.network/mcp)     echo "\${OURS_FAKE_NEW_MCP:-0.9.9}" > "$S/installed_version" ;;
    @ours.network/codex@latest|@ours.network/codex) echo "0.9.9" > "$S/codex_version" ;;
  esac; done
elif [ "$sub" = ls ]; then
  for a in "$@"; do case "$a" in
    @ours.network/codex) echo "@ours.network/codex@$(cat "$S/codex_version" 2>/dev/null || echo 0.9.9)" ;;
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

function run(dir, { bin, state }) {
  return execFileSync('bash', [INSTALL], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      OURS_FAKE_STATE: state,
      CODEX_DIR: join(dir, '.codex'),
      SKILLS_DIR: join(dir, '.agents/skills'),
    },
  });
}

test('daemon on an OLD running version is ensured @latest and RESTARTED; versions echoed', () => {
  const D = mkdtempSync(join(tmpdir(), 'codex-up-'));
  try {
    const env = makeEnv(D);
    writeFileSync(join(env.state, 'installed_version'), '0.3.0\n');
    writeFileSync(join(env.state, 'running'), '');
    writeFileSync(join(env.state, 'running_version'), '0.3.0\n');
    const out = run(D, env);
    const npmLog = readFileSync(join(env.state, 'npm.log'), 'utf8');
    const mcpLog = readFileSync(join(env.state, 'ours-mcp.log'), 'utf8');
    assert.match(npmLog, /i -g @ours\.network\/mcp@latest/);
    assert.match(mcpLog, /\brestart\b/);
    assert.match(out, /daemon: ours-mcp v0\.9\.9/);
    assert.match(out, /plugin: @ours\.network\/codex@0\.9\.9/);
  } finally {
    rmSync(D, { recursive: true, force: true });
  }
});

test('daemon NOT running is ensured @latest and STARTED (not restarted)', () => {
  const D = mkdtempSync(join(tmpdir(), 'codex-up-'));
  try {
    const env = makeEnv(D);
    writeFileSync(join(env.state, 'installed_version'), '0.3.0\n');
    run(D, env);
    const mcpLog = readFileSync(join(env.state, 'ours-mcp.log'), 'utf8');
    assert.match(mcpLog, /\bstart\b/);
    assert.doesNotMatch(mcpLog, /\brestart\b/);
  } finally {
    rmSync(D, { recursive: true, force: true });
  }
});
