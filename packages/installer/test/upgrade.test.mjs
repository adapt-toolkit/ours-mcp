// Upgrade-simulation test for the unified installer: re-running it upgrades the daemon to @latest
// (and restarts on a version change) and installs each selected plugin with @latest (bypassing a
// stale global), then echoes the resulting daemon + plugin versions. Fake `npm`, `ours-mcp`, and
// `ours-hermes-install` bins on PATH so nothing global is touched and no harness bin really runs.
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
  install-service) : ;;
  *) : ;;
esac
`;
const FAKE_NPM = `#!/usr/bin/env bash
S="$OURS_FAKE_STATE"; echo "$*" >> "$S/npm.log"
sub="\${1:-}"
if [ "$sub" = i ] || [ "$sub" = install ] || [ "$sub" = add ]; then
  for a in "$@"; do case "$a" in
    @ours.network/mcp@latest|@ours.network/mcp)           echo "\${OURS_FAKE_NEW_MCP:-0.9.9}" > "$S/installed_version" ;;
    @ours.network/hermes@latest|@ours.network/hermes)     echo "0.9.9" > "$S/hermes_version" ;;
  esac; done
elif [ "$sub" = ls ]; then
  for a in "$@"; do case "$a" in
    @ours.network/hermes) echo "@ours.network/hermes@$(cat "$S/hermes_version" 2>/dev/null || echo 0.9.9)" ;;
  esac; done
fi
exit 0
`;
// The unified installer calls `ours-hermes-install` after installing the plugin; fake it.
const FAKE_HERMES_INSTALL = `#!/usr/bin/env bash
echo "ran ours-hermes-install" >> "$OURS_FAKE_STATE/harness.log"
exit 0
`;

function makeEnv(dir) {
  const bin = join(dir, 'bin');
  const state = join(dir, 'state');
  mkdirSync(bin, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(bin, 'ours-mcp'), FAKE_OURS_MCP); chmodSync(join(bin, 'ours-mcp'), 0o755);
  writeFileSync(join(bin, 'npm'), FAKE_NPM); chmodSync(join(bin, 'npm'), 0o755);
  writeFileSync(join(bin, 'ours-hermes-install'), FAKE_HERMES_INSTALL); chmodSync(join(bin, 'ours-hermes-install'), 0o755);
  return { bin, state };
}

test('unified installer upgrades daemon + plugin to @latest, restarts on change, echoes versions', () => {
  const D = mkdtempSync(join(tmpdir(), 'installer-up-'));
  try {
    const env = makeEnv(D);
    // Old daemon already installed AND running.
    writeFileSync(join(env.state, 'installed_version'), '0.3.0\n');
    writeFileSync(join(env.state, 'running'), '');
    writeFileSync(join(env.state, 'running_version'), '0.3.0\n');

    const out = execFileSync('bash', [INSTALL], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${env.bin}:${process.env.PATH}`,
        OURS_FAKE_STATE: env.state,
        OURS_HARNESSES: 'hermes',
        OURS_SERVICE: 'no',
        OURS_ASSUME_YES: '1',
      },
    });

    const npmLog = readFileSync(join(env.state, 'npm.log'), 'utf8');
    const mcpLog = readFileSync(join(env.state, 'ours-mcp.log'), 'utf8');
    const harnessLog = readFileSync(join(env.state, 'harness.log'), 'utf8');
    assert.match(npmLog, /i -g @ours\.network\/mcp@latest/, 'daemon ensured @latest');
    assert.match(npmLog, /i -g @ours\.network\/hermes@latest/, 'plugin installed @latest');
    assert.match(mcpLog, /\brestart\b/, 'daemon restarted after version change');
    assert.match(harnessLog, /ran ours-hermes-install/, 'harness bin invoked');
    assert.match(out, /versions:/, 'version echo present');
    assert.match(out, /daemon: ours-mcp v0\.9\.9/, 'daemon version echoed');
    assert.match(out, /hermes: @ours\.network\/hermes@0\.9\.9/, 'plugin version echoed');
  } finally {
    rmSync(D, { recursive: true, force: true });
  }
});
