// Integration tests for the unified `ours-install` (v2 flow). No network: fake `npm`, `ours-mcp`,
// `claude`, `codex`, `ours-fleet`, and `ours-tg-connector` are put on PATH; each logs its argv to
// $CALLLOG. We then assert the installer drives them in the right order with the right args,
// non-interactively (OURS_ASSUME_YES=1). HOME is redirected to a temp dir so config writes and the
// interactive-shell `type` probe never touch the real user environment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = dirname(HERE);
const INSTALL_MJS = join(PKG, 'install.mjs');
const INSTALL_SH = join(PKG, 'install.sh');

// Build a temp bin dir of fakes that append "<name> <args>" to $CALLLOG and behave per opts.
//   opts.daemon      : 'installed' (default) | 'absent'
//   opts.daemonPort  : port to advertise in `ours-mcp status` (default 3050)
//   opts.codex       : 'ok' (default) | 'unsafe' (its --version returns junk, non-zero)
//   opts.noHarness   : omit claude+codex bins entirely (nothing detected)
function fakeBins(dir, opts = {}) {
  const daemonInstalled = opts.daemon !== 'absent';
  const port = opts.daemonPort || 3050;
  const write = (n, body) => { const p = join(dir, n); writeFileSync(p, `#!/bin/bash\nprintf '%s %s\\n' "${n}" "$*" >> "$CALLLOG"\n${body}`); chmodSync(p, 0o755); };

  // ours-mcp: --version answers when "installed"; status reports running + a url line for the port.
  const mcpVersion = daemonInstalled
    ? `[ "$1" = "--version" ] && { echo "ours-mcp v9.9.9"; exit 0; }\n`
    : `[ "$1" = "--version" ] && { [ -f "$CALLLOG.mcpinstalled" ] && { echo "ours-mcp v9.9.9"; exit 0; } || exit 1; }\n`;
  write('ours-mcp',
    mcpVersion +
    `[ "$1" = "status" ] && { echo "ours-mcp: running"; echo "  url:    http://localhost:${port}/mcp (reachable)"; exit 0; }\n` +
    `exit 0\n`);

  write('npm',
    `case "$*" in *"@ours.network/mcp"*) touch "$CALLLOG.mcpinstalled";; esac\n` +
    `case "$1" in ls) echo "@ours.network/fleet@0.7.0"; echo "@ours.network/tg-connector@0.1.7";; esac\n` +
    `exit 0\n`);

  if (!opts.noHarness) {
    write('claude', `[ "$1" = "--version" ] && { echo "2.1.181 (Claude Code)"; exit 0; }\nexit 0\n`);
    if (opts.codex === 'unsafe') {
      write('codex', `[ "$1" = "--version" ] && { echo "not-a-version-string"; exit 1; }\nexit 0\n`);
    } else {
      write('codex', `[ "$1" = "--version" ] && { echo "codex-cli 0.144.4"; exit 0; }\nexit 0\n`);
    }
  }
  write('ours-fleet', `[ "$1" = "--version" ] && { echo "0.7.0"; exit 0; }\nexit 0\n`);
  write('ours-tg-connector', `exit 0\n`);
}

// Run install.mjs non-interactively with fakes on PATH. Returns { out, calls, tmp }.
function runInstall(opts = {}, extraEnv = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'installer-'));
  const bin = join(tmp, 'bin');
  mkdirSync(bin, { recursive: true });
  const log = join(tmp, 'calls.log');
  writeFileSync(log, '');
  fakeBins(bin, opts);
  // For the "no harness" case we must guarantee the host's real claude/codex can't leak in via the
  // inherited PATH — so use a restricted PATH (fake bin + coreutils) with node/bash symlinked in.
  let path = `${bin}:${process.env.PATH}`;
  if (opts.noHarness) {
    try { symlinkSync(process.execPath, join(bin, 'node')); } catch { /* already there */ }
    for (const b of ['bash', 'env', 'cat', 'printf']) {
      const p = ['/bin/' + b, '/usr/bin/' + b].find((x) => existsSync(x));
      if (p) { try { symlinkSync(p, join(bin, b)); } catch { /* ignore */ } }
    }
    path = `${bin}:/usr/bin:/bin`;
  }
  const env = {
    PATH: path,
    CALLLOG: log,
    HOME: tmp,               // isolate config writes + the `type` shell probe
    SHELL: '/bin/bash',
    OURS_ASSUME_YES: '1',
    NO_COLOR: '1',
    OURS_CONFIG: join(tmp, '.ours', 'config.json'),
    ...extraEnv,
  };
  let out = '';
  try { out = execFileSync('node', [INSTALL_MJS], { env, encoding: 'utf8', stdio: 'pipe' }); }
  catch (e) { out = (e.stdout || '') + (e.stderr || ''); throw Object.assign(e, { out, calls: readFileSync(log, 'utf8'), tmp }); }
  return { out, calls: readFileSync(log, 'utf8'), tmp };
}

test('update path: daemon present + both harnesses → drives plugin CLIs, fleet, no create-root, no config re-ask', () => {
  const { out, calls, tmp } = runInstall({ daemon: 'installed' });
  // Config-first questions are SKIPPED when a daemon already exists.
  assert.doesNotMatch(out, /A couple of quick settings/, 'no Step 0 on an already-configured daemon');
  // Daemon reused, not reinstalled/restarted (update is opt-in and default is No under assume-yes).
  assert.doesNotMatch(calls, /npm i -g @ours\.network\/mcp/, 'daemon not reinstalled without an explicit update yes');
  assert.doesNotMatch(calls, /ours-mcp (start|restart)/, 'running daemon not restarted');
  // Root identity is DEFERRED to the hand-off — never created in-flow.
  assert.doesNotMatch(calls, /ours-mcp create-root/, 'root identity must be deferred, not created in-flow');
  // Claude plugin driven headlessly.
  assert.match(calls, /claude plugin marketplace add adapt-toolkit\/ours-claude-marketplace/, 'claude marketplace add');
  assert.match(calls, /claude plugin install ours@ours\.network/, 'claude plugin install (plugin@marketplace)');
  // Codex plugin + ours-codex launcher in the same step.
  assert.match(calls, /codex plugin marketplace add adapt-toolkit\/ours-codex-marketplace/, 'codex marketplace add');
  assert.match(calls, /codex plugin add ours@ours-codex-marketplace/, 'codex plugin add');
  assert.match(calls, /npm i -g @ours\.network\/codex@latest/, 'ours-codex launcher installed with the codex plugin');
  // ours-fleet installed + host setup.
  assert.match(calls, /npm i -g @ours\.network\/fleet@latest/, 'fleet package installed');
  assert.match(calls, /ours-fleet init/, 'fleet host setup run');
  // Telegram default No → skipped, and its hand-off step drops out.
  assert.doesNotMatch(calls, /ours-tg-connector/, 'telegram skipped by default');
  assert.match(out, /Telegram connector.*skipped/, 'summary shows telegram skipped');
  assert.match(out, /paste this into your agent/, 'final copy-paste hand-off present');
  assert.doesNotMatch(out, /Set up my Telegram bot/, 'hand-off drops the skipped telegram step');
  assert.match(out, /Set up ours-fleet/, 'hand-off keeps the installed fleet step');
  rmSync(tmp, { recursive: true, force: true });
});

test('first install: config-first Step 0 runs, daemon installed once with config, service, no create-root', () => {
  const { out, calls, tmp } = runInstall({ daemon: 'absent' });
  assert.match(out, /A couple of quick settings/, 'Step 0 config questions run on a first install');
  assert.match(out, /1\/4 — ours core/, 'daemon is step 1');
  assert.match(calls, /npm i -g @ours\.network\/mcp@latest/, 'daemon installed on consent');
  assert.match(calls, /ours-mcp start/, 'daemon started once');
  assert.match(calls, /ours-mcp install-service/, 'installed as a boot service');
  assert.doesNotMatch(calls, /ours-mcp create-root/, 'root identity deferred to the hand-off');
  // Config written with a real numeric port that is never the reserved 3051.
  const cfg = join(tmp, '.ours', 'config.json');
  assert.ok(existsSync(cfg), 'config.json written');
  const parsed = JSON.parse(readFileSync(cfg, 'utf8'));
  assert.ok(Number.isInteger(parsed.port), 'a numeric port persisted');
  assert.notEqual(parsed.port, 3051, 'never the reserved Telegram port');
  rmSync(tmp, { recursive: true, force: true });
});

test('never dead-end: an undrivable codex prints a manual path and the flow continues', () => {
  const { out, calls, tmp } = runInstall({ daemon: 'installed', codex: 'unsafe' });
  // We must NOT try to drive an unsafe codex…
  assert.doesNotMatch(calls, /codex plugin/, 'unsafe codex is never driven');
  // …but we ALSO never dead-end: a manual install path is always printed.
  assert.match(out, /codex plugin marketplace add adapt-toolkit\/ours-codex-marketplace/, 'manual codex install path shown');
  assert.match(out, /npm i -g @ours\.network\/codex/, 'manual ours-codex launcher path shown');
  // Claude still installs and the rest of the flow runs.
  assert.match(calls, /claude plugin install ours@ours\.network/, 'the good harness still installs');
  assert.match(calls, /ours-fleet init/, 'the flow continues to later steps');
  rmSync(tmp, { recursive: true, force: true });
});

test('no harness at all: explains + exits cleanly, installs nothing', () => {
  const { out, calls, tmp } = runInstall({ daemon: 'installed', noHarness: true });
  assert.match(out, /No Claude Code or Codex found/, 'says no harness is present');
  assert.match(out, /Install one of them first/, 'tells the user what to do');
  assert.doesNotMatch(calls, /plugin/, 'no plugin work without a harness');
  assert.doesNotMatch(calls, /ours-fleet init/, 'bails before the later steps');
  rmSync(tmp, { recursive: true, force: true });
});

// --- install.sh bootstrap: Node.js check (unchanged contract) ----------------------------------
test('install.sh with no Node.js prints friendly per-OS guidance and exits 0', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'installer-'));
  const bin = join(tmp, 'bin');
  mkdirSync(bin, { recursive: true });
  const out = execFileSync('bash', [INSTALL_SH], {
    env: { PATH: '/usr/bin:/bin' + `:${bin}`, HOME: tmp },
    stdio: 'pipe', encoding: 'utf8',
  }).toString();
  let hasNode = true;
  try { execFileSync('bash', ['-c', 'command -v node'], { env: { PATH: '/usr/bin:/bin' }, stdio: 'ignore' }); }
  catch { hasNode = false; }
  if (hasNode) { rmSync(tmp, { recursive: true, force: true }); return; } // system node leaks in; skip
  assert.match(out, /Node\.js/, 'explains Node.js is needed');
  assert.match(out, /nodejs\.org/, 'links nodejs.org');
  assert.doesNotMatch(out, /install\.mjs/, 'must not try to run the Node installer without node');
  rmSync(tmp, { recursive: true, force: true });
});
