// Upgrade-simulation tests for install.sh: daemon ensured @latest + restart-on-change, guarded
// legacy connector-era cleanup (connector files, gateway .env secret, ours-wake routes), and the
// ~/.agents/skills shadow refresh (stale connector-era copy refreshed; a current or non-ours copy
// left untouched). Fake `npm` + `ours-mcp` bins on PATH so nothing global is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
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
    @ours.network/mcp@latest|@ours.network/mcp)           echo "\${OURS_FAKE_NEW_MCP:-0.9.9}" > "$S/installed_version" ;;
    @ours.network/openclaw@latest|@ours.network/openclaw) echo "0.9.9" > "$S/openclaw_version" ;;
  esac; done
elif [ "$sub" = ls ]; then
  for a in "$@"; do case "$a" in
    @ours.network/openclaw) echo "@ours.network/openclaw@$(cat "$S/openclaw_version" 2>/dev/null || echo 0.9.9)" ;;
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

function run(openclawDir, agentsSkills, { bin, state }, extraEnv = {}) {
  return execFileSync('bash', [INSTALL], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      OURS_FAKE_STATE: state,
      OPENCLAW_DIR: openclawDir,
      AGENTS_SKILLS: agentsSkills,
      ...extraEnv,
    },
  });
}

test('daemon on an OLD running version is ensured @latest and RESTARTED; versions echoed', () => {
  const D = mkdtempSync(join(tmpdir(), 'oc-up-'));
  try {
    const env = makeEnv(D);
    writeFileSync(join(env.state, 'installed_version'), '0.3.0\n');
    writeFileSync(join(env.state, 'running'), '');
    writeFileSync(join(env.state, 'running_version'), '0.3.0\n');
    const out = run(join(D, '.openclaw'), join(D, '.agents-skills'), env);
    const npmLog = readFileSync(join(env.state, 'npm.log'), 'utf8');
    const mcpLog = readFileSync(join(env.state, 'ours-mcp.log'), 'utf8');
    assert.match(npmLog, /i -g @ours\.network\/mcp@latest/);
    assert.match(mcpLog, /\brestart\b/);
    assert.match(out, /daemon: ours-mcp v0\.9\.9/);
    assert.match(out, /plugin: @ours\.network\/openclaw@0\.9\.9/);
  } finally {
    rmSync(D, { recursive: true, force: true });
  }
});

test('legacy connector cleanup: connector files, gateway .env secret, and ours-wake routes removed; mcp block kept', () => {
  const D = mkdtempSync(join(tmpdir(), 'oc-up-'));
  const O = join(D, '.openclaw');
  try {
    const env = makeEnv(D);
    mkdirSync(O, { recursive: true });
    writeFileSync(join(O, 'ours-connector.env'), 'export OURS_WAKE_SECRET="x"\n');
    writeFileSync(join(O, 'ours-connector.log'), 'log\n');
    writeFileSync(join(O, 'ours-connector-agent1.log'), 'log\n');
    writeFileSync(join(O, 'ours-watch-agent1.pid'), '12345\n');
    writeFileSync(join(O, '.env'), 'OTHER=keepme\nOURS_WAKE_SECRET=deadbeef\n');
    writeFileSync(join(O, 'openclaw.json'), JSON.stringify({
      '//ours': 'ours.network plugin (managed block)',
      mcp: { servers: { ours: { command: 'ours-mcp', args: ['proxy'] } } },
      plugins: { entries: { webhooks: { config: { routes: {
        'ours-wake-agent1': { path: '/plugins/webhooks/ours-wake-agent1', events: ['ours_wake'] },
      } } } } },
    }, null, 2) + '\n');

    run(O, join(D, '.agents-skills'), env, { OURS_INSTALL_SKIP_DAEMON: '1' });

    assert.ok(!existsSync(join(O, 'ours-connector.env')), 'connector env removed');
    assert.ok(!existsSync(join(O, 'ours-connector.log')), 'connector log removed');
    assert.ok(!existsSync(join(O, 'ours-connector-agent1.log')), 'per-id connector log removed');
    assert.ok(!existsSync(join(O, 'ours-watch-agent1.pid')), 'per-id watcher pid removed');
    const dotenv = readFileSync(join(O, '.env'), 'utf8');
    assert.doesNotMatch(dotenv, /OURS_WAKE_SECRET/, 'gateway secret line removed');
    assert.match(dotenv, /OTHER=keepme/, 'unrelated env line kept');
    const cfg = JSON.parse(readFileSync(join(O, 'openclaw.json'), 'utf8'));
    assert.equal(cfg.plugins?.entries?.webhooks?.config?.routes?.['ours-wake-agent1'], undefined, 'ours-wake route removed');
    assert.equal(cfg.mcp.servers.ours.command, 'ours-mcp', 'mcp.servers.ours kept');
    // legacy //ours root marker (which OpenClaw's strict schema rejects) is healed away
    assert.equal(cfg['//ours'], undefined, 'legacy //ours root marker stripped');
    assert.deepEqual(Object.keys(cfg).filter((k) => k.startsWith('//')), [], 'config is doctor-clean (no `//` root keys)');
  } finally {
    rmSync(D, { recursive: true, force: true });
  }
});

test('shadow refresh: a STALE connector-era ~/.agents/skills/ours copy is refreshed to current', () => {
  const D = mkdtempSync(join(tmpdir(), 'oc-up-'));
  const AG = join(D, '.agents-skills');
  try {
    const env = makeEnv(D);
    mkdirSync(join(AG, 'ours'), { recursive: true });
    // A stale, ours-owned skill (mentions ours.network AND the connector-era term).
    writeFileSync(join(AG, 'ours', 'SKILL.md'), '---\nname: ours\n---\nOld ours.network skill using the connector watcher + ours-wake webhook route.\n');
    run(join(D, '.openclaw'), AG, env, { OURS_INSTALL_SKIP_DAEMON: '1' });
    const refreshed = readFileSync(join(AG, 'ours', 'SKILL.md'), 'utf8');
    assert.doesNotMatch(refreshed, /connector/i, 'connector-era wording gone after refresh');
    assert.match(refreshed, /ours\.network/i, 'still the ours skill');
    // and it now equals the current shipped skill
    const current = readFileSync(join(PKG, 'skills', 'ours', 'SKILL.md'), 'utf8');
    assert.equal(refreshed, current, 'refreshed to the current shipped skill');
  } finally {
    rmSync(D, { recursive: true, force: true });
  }
});

test('shadow refresh guard: a CURRENT ~/.agents/skills/ours copy (no connector marker) is left untouched', () => {
  const D = mkdtempSync(join(tmpdir(), 'oc-up-'));
  const AG = join(D, '.agents-skills');
  try {
    const env = makeEnv(D);
    mkdirSync(join(AG, 'ours'), { recursive: true });
    const sentinel = 'CODEX-CURRENT-DO-NOT-TOUCH ours.network skill (in-session watch)\n';
    writeFileSync(join(AG, 'ours', 'SKILL.md'), sentinel);
    run(join(D, '.openclaw'), AG, env, { OURS_INSTALL_SKIP_DAEMON: '1' });
    assert.equal(readFileSync(join(AG, 'ours', 'SKILL.md'), 'utf8'), sentinel, 'current copy untouched');
  } finally {
    rmSync(D, { recursive: true, force: true });
  }
});

test('shadow refresh guard: a NON-ours ~/.agents/skills/ours copy is left untouched', () => {
  const D = mkdtempSync(join(tmpdir(), 'oc-up-'));
  const AG = join(D, '.agents-skills');
  try {
    const env = makeEnv(D);
    mkdirSync(join(AG, 'ours'), { recursive: true });
    // Contains "connector" but NOT "ours.network" — a user's own unrelated skill; must not be touched.
    const userSkill = '---\nname: ours\n---\nMy own skill about a database connector.\n';
    writeFileSync(join(AG, 'ours', 'SKILL.md'), userSkill);
    run(join(D, '.openclaw'), AG, env, { OURS_INSTALL_SKIP_DAEMON: '1' });
    assert.equal(readFileSync(join(AG, 'ours', 'SKILL.md'), 'utf8'), userSkill, 'non-ours copy untouched');
  } finally {
    rmSync(D, { recursive: true, force: true });
  }
});
