// Upgrade-simulation tests for install.sh: prove that re-running the installer over an OLD
// install is a CLEAN UPGRADE — the daemon is ensured @latest (not skipped) and restarted when the
// version changed, legacy connector-era artifacts are removed, the current skill/config land, and
// versions are echoed. Uses fake `npm` + `ours-mcp` bins on PATH so nothing global is touched.
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
    @ours.network/mcp@latest|@ours.network/mcp)       echo "\${OURS_FAKE_NEW_MCP:-0.9.9}" > "$S/installed_version" ;;
    @ours.network/hermes@latest|@ours.network/hermes) echo "0.9.9" > "$S/hermes_version" ;;
  esac; done
elif [ "$sub" = ls ]; then
  for a in "$@"; do case "$a" in
    @ours.network/hermes) echo "@ours.network/hermes@$(cat "$S/hermes_version" 2>/dev/null || echo 0.9.9)" ;;
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

function run(hermesDir, dir, { bin, state }, extraEnv = {}) {
  return execFileSync('bash', [INSTALL], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      OURS_FAKE_STATE: state,
      HERMES_DIR: hermesDir,
      AGENTS_SKILLS: join(dir, '.agents-skills'),
      ...extraEnv,
    },
  });
}

test('daemon on an OLD running version is ensured @latest and RESTARTED; versions echoed', () => {
  const D = mkdtempSync(join(tmpdir(), 'hermes-up-'));
  try {
    const env = makeEnv(D);
    // Simulate an old daemon that is already installed AND running.
    writeFileSync(join(env.state, 'installed_version'), '0.3.0\n');
    writeFileSync(join(env.state, 'running'), '');
    writeFileSync(join(env.state, 'running_version'), '0.3.0\n');

    const out = run(join(D, '.hermes'), D, env);

    const npmLog = readFileSync(join(env.state, 'npm.log'), 'utf8');
    const mcpLog = readFileSync(join(env.state, 'ours-mcp.log'), 'utf8');
    assert.match(npmLog, /i -g @ours\.network\/mcp@latest/, 'daemon ensured @latest');
    assert.equal(readFileSync(join(env.state, 'installed_version'), 'utf8').trim(), '0.9.9', 'daemon upgraded');
    assert.match(mcpLog, /\brestart\b/, 'daemon restarted after a version change');
    assert.doesNotMatch(mcpLog, /\bstart\b/, 'restart used (not start) since it was running');
    assert.match(out, /versions:/, 'version echo present');
    assert.match(out, /daemon: ours-mcp v0\.9\.9/, 'echoes the new daemon version');
    assert.match(out, /plugin: @ours\.network\/hermes@0\.9\.9/, 'echoes the plugin version');
  } finally {
    rmSync(D, { recursive: true, force: true });
  }
});

test('daemon NOT running is ensured @latest and STARTED (not restarted)', () => {
  const D = mkdtempSync(join(tmpdir(), 'hermes-up-'));
  try {
    const env = makeEnv(D);
    writeFileSync(join(env.state, 'installed_version'), '0.3.0\n'); // present but not running
    const out = run(join(D, '.hermes'), D, env);
    const mcpLog = readFileSync(join(env.state, 'ours-mcp.log'), 'utf8');
    assert.match(mcpLog, /\bstart\b/, 'daemon started');
    assert.doesNotMatch(mcpLog, /\brestart\b/, 'no restart when it was not running');
    assert.match(out, /daemon: ours-mcp v0\.9\.9/);
  } finally {
    rmSync(D, { recursive: true, force: true });
  }
});

test('daemon already on latest is NOT restarted', () => {
  const D = mkdtempSync(join(tmpdir(), 'hermes-up-'));
  try {
    const env = makeEnv(D);
    writeFileSync(join(env.state, 'installed_version'), '0.9.9\n');
    writeFileSync(join(env.state, 'running'), '');
    writeFileSync(join(env.state, 'running_version'), '0.9.9\n');
    run(join(D, '.hermes'), D, env, { OURS_FAKE_NEW_MCP: '0.9.9' });
    const mcpLog = readFileSync(join(env.state, 'ours-mcp.log'), 'utf8');
    assert.doesNotMatch(mcpLog, /\brestart\b/, 'no restart when already latest');
    assert.doesNotMatch(mcpLog, /\bstart\b/, 'no start when already running latest');
  } finally {
    rmSync(D, { recursive: true, force: true });
  }
});

test('legacy connector-era artifacts are removed and the config block is refreshed to mcp-only', () => {
  const D = mkdtempSync(join(tmpdir(), 'hermes-up-'));
  const H = join(D, '.hermes');
  try {
    const env = makeEnv(D);
    mkdirSync(H, { recursive: true });
    // Plant legacy connector artifacts.
    writeFileSync(join(H, 'ours-connector.env'), 'export CONNECTOR_HMAC_SECRET="deadbeef"\n');
    writeFileSync(join(H, 'ours-connector.log'), 'old watcher log\n');
    // Plant a LEGACY managed block in config.yaml (with the ours-wake webhook route + secret).
    writeFileSync(join(H, 'config.yaml'), `# >>> ours.network plugin (managed block)
mcp_servers:
  ours:
    command: "ours-mcp"
    args: ["proxy"]
    enabled: true
platforms:
  webhook:
    enabled: true
    extra:
      port: 8644
      routes:
        ours-wake:
          events: ["ours_wake"]
          secret: "deadbeefsecret"
          skills: ["ours"]
# <<< ours.network plugin
`);

    run(H, D, env, { OURS_INSTALL_SKIP_DAEMON: '1' });

    assert.ok(!existsSync(join(H, 'ours-connector.env')), 'legacy connector env removed');
    assert.ok(!existsSync(join(H, 'ours-connector.log')), 'legacy connector log removed');
    const cfg = readFileSync(join(H, 'config.yaml'), 'utf8');
    assert.doesNotMatch(cfg, /ours-wake|ours_wake|platforms:|deadbeefsecret|secret:/, 'no connector wake-route/secret left');
    assert.match(cfg, /command: "ours-mcp"/, 'current mcp server block present');
    assert.match(cfg, /args: \["proxy", "--application", "hermes"\]/, 'managed block carries the durable Hermes association');
    assert.equal((cfg.match(/# >>> ours\.network plugin/g) || []).length, 1, 'exactly one managed block');
  } finally {
    rmSync(D, { recursive: true, force: true });
  }
});
