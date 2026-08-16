// Integration tests for the unified `ours-install` (v2 flow). No network: fake `npm`, `ours-mcp`,
// `claude`, `codex`, `ours-fleet`, and `ours-tg-connector` are put on PATH; each logs its argv to
// $CALLLOG. We then assert the installer drives them in the right order with the right args,
// non-interactively (OURS_ASSUME_YES=1). HOME is redirected to a temp dir so config writes and the
// interactive-shell `type` probe never touch the real user environment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync, mkdirSync, statSync, symlinkSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveChannel, coworkDaemonMode as coworkDaemonModeOf } from '../lib/logic.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = dirname(HERE);
const INSTALL_MJS = join(PKG, 'install.mjs');
const INSTALL_SH = join(PKG, 'install.sh');

// Build a temp bin dir of fakes that append "<name> <args>" to $CALLLOG and behave per opts.
//   opts.daemon      : 'installed' (default) | 'absent'
//   opts.daemonState : 'managed' (default) | 'stopped' | 'external'
//   opts.daemonPort  : port to advertise in `ours-mcp status` (default 3050)
//   opts.codex       : 'ok' (default) | 'unsafe' (its --version returns junk, non-zero)
//   opts.noHarness   : omit claude+codex bins entirely (nothing detected)
//   opts.rootExists  : name → `ours-mcp create-root` reports it already exists (quiet no-op)
//   opts.updateVersion : report v9.9.8 until npm updates core, then v9.9.9
//   opts.voiceRestartTrace : model the canonical voice command's one restart in the call log
//   opts.voiceRecoveryFailure : canonical setup exits 2 after its traced restart/rollback attempt
//   opts.hermesPresent : create <HOME>/.hermes so Hermes is detected (config-dir based, handled in runInstall)
//   opts.serviceFails  : `ours-mcp install-service` STOPS the daemon and then fails, exactly as
//                        core's cmdInstallService does when `systemctl --user enable --now` cannot
//                        reach a user bus. With it, `status`/`create-root` track real up/down state.
function fakeBins(dir, opts = {}) {
  const daemonInstalled = opts.daemon !== 'absent';
  const daemonState = opts.daemonState || 'managed';
  const port = opts.daemonPort || 3050;
  const write = (n, body) => { const p = join(dir, n); writeFileSync(p, `#!/bin/bash\nprintf '%s %s\\n' "${n}" "$*" >> "$CALLLOG"\n${body}`); chmodSync(p, 0o755); };

  // ours-mcp: --version answers when "installed"; status reports running + a url line for the port;
  // create-root is a quiet no-op that echoes the existing name when opts.rootExists is set.
  const installedVersion = opts.updateVersion
    ? `[ -f "$CALLLOG.mcpupdated" ] && echo "ours-mcp v9.9.9" || echo "ours-mcp v9.9.8"`
    : 'echo "ours-mcp v9.9.9"';
  const mcpVersion = daemonInstalled
    ? `[ "$1" = "--version" ] && { ${installedVersion}; exit 0; }\n`
    : `[ "$1" = "--version" ] && { [ -f "$CALLLOG.mcpinstalled" ] && { echo "ours-mcp v9.9.9"; exit 0; } || exit 1; }\n`;
  const createRoot = opts.rootExists
    ? `[ "$1" = "create-root" ] && { echo 'create-root: a root identity already exists ("${opts.rootExists}") — nothing to do.'; exit 0; }\n`
    : `[ "$1" = "create-root" ] && { ${opts.serviceFails ? '[ -f "$CALLLOG.up" ] || { echo "create-root: the daemon is not running" >&2; exit 1; }; ' : ''}echo "created root identity"; exit 0; }\n`;
  // serviceFails models core's cmdInstallService faithfully: stop first, THEN fail. The
  // $CALLLOG.up marker is the daemon's real liveness, so status/create-root cannot claim
  // a daemon the install-service step just took down.
  const lifecycle = opts.serviceFails
    ? `[ "$1" = "start" ] && { touch "$CALLLOG.up"; echo "ours-mcp is up"; exit 0; }\n` +
      `[ "$1" = "install-service" ] && { rm -f "$CALLLOG.up"; echo "failed to enable/start the service via systemctl --user." >&2; exit 1; }\n`
    : '';
  // The port a real daemon reports is the one it was configured with, so a re-run sees the port
  // the previous run persisted (which is probe-dependent — 3050 may be busy on the test machine).
  // Read it back from the config when there is one, exactly as the daemon would.
  const resolvePort = `P=$(grep -o '"port"[^,}]*' "\${OURS_CONFIG:-/nonexistent}" 2>/dev/null | grep -oE '[0-9]+' | head -1); P=\${P:-${port}};`;
  const statusBody = opts.serviceFails
    ? `${resolvePort} if [ -f "$CALLLOG.up" ]; then echo "ours-mcp: running"; echo "  pid:    4242"; echo "  url:    http://localhost:$P/mcp (reachable)"; exit 0; else echo "ours-mcp: stopped"; exit 1; fi;`
    : daemonState === 'stopped'
      ? 'echo "ours-mcp: stopped"; exit 1;'
      : daemonState === 'external'
        ? `${resolvePort} echo "ours-mcp: running (no pidfile — external launcher)"; echo "  url:    http://localhost:$P/mcp (reachable)"; exit 0;`
        : `${resolvePort} echo "ours-mcp: running"; echo "  pid:    4242"; echo "  url:    http://localhost:$P/mcp (reachable)"; exit 0;`;
  // A dedicated daemon is driven with OURS_CONFIG/OURS_STATE_DIR/OURS_SERVICE_NAME in its
  // environment — log those so a test can prove WHICH daemon each call was aimed at.
  const envTrace = `[ -n "$OURS_SERVICE_NAME" ] && printf 'ours-mcp-env %s service=%s config=%s state=%s\\n' "$1" "$OURS_SERVICE_NAME" "$OURS_CONFIG" "$OURS_STATE_DIR" >> "$CALLLOG"\n`;
  write('ours-mcp',
    envTrace +
    mcpVersion +
    lifecycle +
    `[ "$1" = "status" ] && { ${statusBody} }\n` +
    `[ "$1" = "voice-status" ] && { if [ -f "$CALLLOG.voice-ready" ]; then echo '{"ready":true,"provider":"deepgram","apiKey":"configured","keySource":"config"}'; exit 0; else exit 1; fi; }\n` +
    `[ "$1" = "voice-setup" ] && { ${opts.voiceRestartTrace
      ? `echo "voice-provider-selected" >> "$CALLLOG"; echo "voice-config-written" >> "$CALLLOG"; echo "ours-mcp restart (voice-setup)" >> "$CALLLOG";`
      : ''} ${opts.voiceRecoveryFailure
      ? 'echo "canonical voice setup recovered by rollback"; exit 2;'
      : 'touch "$CALLLOG.voice-ready"; echo "canonical ours-mcp voice-setup completed"; exit 0;'} }\n` +
    createRoot +
    `exit 0\n`);

  write('npm',
    `case "$*" in *"@ours.network/mcp"*) touch "$CALLLOG.mcpinstalled" "$CALLLOG.mcpupdated";; esac\n` +
    `case "$1" in ls) echo "@ours.network/fleet@0.7.0"; echo "@ours.network/tg-connector@0.1.7"; echo "@ours.network/cowork@0.4.0";; esac\n` +
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
  // Snapshot the connector's config AS IT STANDS when install-service runs. `install-service`
  // bakes what it resolves into the service unit, so a config written afterwards would be too
  // late — the snapshot is what proves the installer configured it FIRST.
  write('ours-tg-connector',
    `[ "$1" = "install-service" ] && { cp "$HOME/.ours-telegram/config.json" "$CALLLOG.tgsnapshot" 2>/dev/null; exit 0; }\nexit 0\n`);
  // Hermes plugin front-door: logs its argv (so we can assert --skip-daemon) and succeeds.
  write('ours-hermes-install', `exit 0\n`);
  // Rooms: snapshot cowork's config when its service is installed, for the same reason as
  // the connector — install-service is the moment the resolved settings get frozen.
  write('ours-cowork',
    `[ "$1" = "install-service" ] && { cp "\${OURS_COWORK_CONFIG:-$HOME/.ours-cowork/config.json}" "$CALLLOG.cwsnapshot" 2>/dev/null; ${opts.coworkServiceFails ? 'exit 1' : 'exit 0'}; }\nexit 0\n`);
}

// Run install.mjs non-interactively with fakes on PATH. Returns { out, calls, tmp }.
function runInstall(opts = {}, extraEnv = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'installer-'));
  const bin = join(tmp, 'bin');
  mkdirSync(bin, { recursive: true });
  const log = join(tmp, 'calls.log');
  writeFileSync(log, '');
  fakeBins(bin, opts);
  // Hermes is detected by its config dir (HOME/.hermes, since HOME=tmp) existing — create it on demand.
  if (opts.hermesPresent) mkdirSync(join(tmp, '.hermes'), { recursive: true });
  if (opts.config) {
    mkdirSync(join(tmp, '.ours'), { recursive: true });
    writeFileSync(join(tmp, '.ours', 'config.json'), JSON.stringify(opts.config, null, 2) + '\n', { mode: 0o600 });
  }
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

test('update path: daemon present → drives plugin CLIs, creates human identity in-install, fleet, no config re-ask', () => {
  const { out, calls, tmp } = runInstall({ daemon: 'installed' });
  // Config questions are SKIPPED when a daemon already exists — its port is reused.
  assert.doesNotMatch(out, /Which local port should the shared daemon use\?/, 'no port re-ask on an already-configured daemon');
  assert.match(out, /Shared daemon already configured — port 3050/, 'the running daemon\'s port is what everything is wired to');
  // Daemon reused, not reinstalled/restarted (update is opt-in and default is No under assume-yes).
  assert.doesNotMatch(calls, /npm i -g @ours\.network\/mcp/, 'daemon not reinstalled without an explicit update yes');
  assert.doesNotMatch(calls, /ours-mcp (start|restart)/, 'running daemon not restarted');
  // Human identity is created DURING install now (via the create-root seam), after the daemon is up.
  assert.match(calls, /ours-mcp create-root /, 'human identity created in-install');
  assert.match(out, /Your human identity/, 'user-facing wording is "human identity"');
  // Claude plugin driven headlessly.
  assert.match(calls, /claude plugin marketplace add adapt-toolkit\/ours-claude-marketplace/, 'claude marketplace add');
  assert.match(calls, /claude plugin install ours@ours\.network/, 'claude plugin install (plugin@marketplace)');
  // Codex plugin + ours-codex launcher in the same step, plus the plain explanation.
  assert.match(calls, /codex plugin marketplace add adapt-toolkit\/ours-codex-marketplace/, 'codex marketplace add');
  assert.match(calls, /codex plugin add ours@ours-codex-marketplace/, 'codex plugin add');
  assert.match(calls, /npm i -g @ours\.network\/codex@latest/, 'ours-codex launcher installed with the codex plugin');
  assert.match(out, /AUTO wake-up/, 'explains what ours-codex is (background wake vs blocking)');
  // ours-fleet: CLI + host setup. The already-installed core ours plugin points
  // agents at `ours-fleet docs`; no second fleet-specific plugin is needed.
  assert.match(calls, /npm i -g @ours\.network\/fleet@latest/, 'fleet package installed');
  assert.match(calls, /ours-fleet init/, 'fleet host setup run');
  assert.doesNotMatch(calls, /claude plugin install fleet@ours\.network/,
    'does not install the retired Claude fleet plugin');
  assert.doesNotMatch(calls, /codex plugin add ours-fleet@ours-codex-marketplace/,
    'does not install the retired Codex fleet plugin');
  assert.match(out, /ours-fleet docs/,
    'reports the authoritative discovery command provided by the core skill');
  // Telegram default No → skipped, and its hand-off step drops out.
  assert.doesNotMatch(calls, /ours-tg-connector/, 'telegram skipped by default');
  assert.match(out, /Telegram connector.*skipped/, 'summary shows telegram skipped');
  // Hand-off: identity already created in-install → its step drops; fleet kept; telegram dropped.
  assert.match(out, /paste this into your agent/, 'final copy-paste hand-off present');
  assert.doesNotMatch(out, /Create my Ours human identity/, 'identity created in-install drops from the hand-off');
  assert.doesNotMatch(out, /Set up my Telegram bot/, 'hand-off drops the skipped telegram step');
  assert.match(out, /Set up my ours-fleet/, 'hand-off keeps the (permanent-team) fleet step');
  assert.match(out, /PERMANENT use/, 'fleet hand-off asks for a permanent team, not a temp-agent demo');
  rmSync(tmp, { recursive: true, force: true });
});

test('first install: config-first Step 0, daemon installed once with config + service, human identity created', () => {
  const { out, calls, tmp } = runInstall({ daemon: 'absent' });
  // The shared daemon owns its own configuration inside its own visible step.
  assert.match(out, /1\/5 — the shared ours daemon/, 'the shared daemon is step 1, before every consumer');
  assert.match(out, /The daemon listens on a local port/, 'the port is configured inside the daemon step');
  assert.match(out, /Shared daemon: port \d+, broker standard/, 'the chosen endpoint is stated back');
  assert.doesNotMatch(out, /A couple of quick settings/, 'no nameless config preamble any more');
  // Non-interactive takes the offered default rather than prompting. (Which port that
  // is stays probe-dependent — 3050 may genuinely be busy on the machine running this.)
  assert.doesNotMatch(out, /Suggesting \d+ instead/, 'a free default is accepted without a retry loop');
  assert.match(calls, /npm i -g @ours\.network\/mcp@latest/, 'daemon installed on consent');
  assert.match(calls, /ours-mcp start/, 'daemon started once');
  assert.match(calls, /ours-mcp install-service/, 'installed as a boot service');
  assert.match(calls, /ours-mcp create-root /, 'human identity created in-install after the daemon is up');
  // Config written with a real numeric port that is never the reserved 3051.
  const cfg = join(tmp, '.ours', 'config.json');
  assert.ok(existsSync(cfg), 'config.json written');
  const parsed = JSON.parse(readFileSync(cfg, 'utf8'));
  assert.ok(Number.isInteger(parsed.port), 'a numeric port persisted');
  assert.notEqual(parsed.port, 3051, 'never the reserved Telegram port');
  assert.equal(parsed.stt, undefined, 'non-interactive fresh install never invents voice provider credentials');
  assert.match(out, /Non-interactive mode leaves it unchanged/, 'headless voice setup is explicit and never blocks');
  rmSync(tmp, { recursive: true, force: true });
});

test('update/rerun with complete voice setup detects capability and preserves the secret', () => {
  const secret = 'placeholder-provider-key-123';
  const config = { port: 3050, stt: { provider: 'deepgram', apiKey: secret, model: 'nova-test' } };
  const { out, tmp } = runInstall({ daemon: 'installed', config });
  assert.match(out, /Voice transcription is configured \(deepgram\)/);
  assert.doesNotMatch(out, new RegExp(secret), 'secret never appears in installer output');
  const after = JSON.parse(readFileSync(join(tmp, '.ours', 'config.json'), 'utf8'));
  assert.equal(after.stt.apiKey, secret, 'idempotent rerun keeps the configured key');
  assert.equal(statSync(join(tmp, '.ours', 'config.json')).mode & 0o777, 0o600);
  rmSync(tmp, { recursive: true, force: true });
});

test('update with missing voice setup in non-interactive mode declines safely and offers rerun', () => {
  const { out, tmp } = runInstall({ daemon: 'installed', config: { port: 3050 } });
  assert.match(out, /Voice transcription is not configured/);
  assert.match(out, /Run `ours-mcp voice-setup` in a terminal/);
  const after = JSON.parse(readFileSync(join(tmp, '.ours', 'config.json'), 'utf8'));
  assert.equal(after.stt, undefined);
  rmSync(tmp, { recursive: true, force: true });
});

test('environment-only complete voice setup is recognized without persisting the key', () => {
  const secret = 'environment-placeholder-key-123';
  const { out, tmp } = runInstall(
    { daemon: 'installed', config: { port: 3050 } },
    { OURS_STT_PROVIDER: 'deepgram', OURS_STT_API_KEY: secret },
  );
  assert.match(out, /Voice transcription is configured \(deepgram\)/);
  assert.doesNotMatch(out, new RegExp(secret));
  const after = JSON.parse(readFileSync(join(tmp, '.ours', 'config.json'), 'utf8'));
  assert.equal(after.stt, undefined, 'environment key is not copied into config');
  rmSync(tmp, { recursive: true, force: true });
});

test('human identity already exists → friendly "keeping it" with the name, not an error', () => {
  const { out, calls, tmp } = runInstall({ daemon: 'installed', rootExists: 'Vitalii' });
  assert.match(calls, /ours-mcp create-root /, 'create-root attempted');
  assert.match(out, /already have a human identity \("Vitalii"\)/, 'reports the existing name');
  assert.match(out, /keeping it/, 'a keep, not an error');
  assert.doesNotMatch(out, /needs attention.*[Hh]uman identity/, 'existing identity is not flagged as a failure');
  rmSync(tmp, { recursive: true, force: true });
});

test('hermes present (~/.hermes) → offered and installed via npm + ours-hermes-install --skip-daemon, no regression', () => {
  const { out, calls, tmp } = runInstall({ daemon: 'installed', hermesPresent: true });
  // Detected as a harness alongside Claude Code + Codex (config-dir based, not a driven CLI).
  assert.match(out, /'hermes'/, 'hermes reported in the machine check');
  // Its plugin is the npm package + the front-door, run with --skip-daemon because the unified
  // installer already owns the daemon (Step 1) — ours-hermes-install must not re-ensure/restart it.
  assert.match(calls, /npm i -g @ours\.network\/hermes@latest/, 'hermes plugin package installed');
  assert.match(calls, /ours-hermes-install --skip-daemon/, 'ran the front-door with --skip-daemon');
  assert.match(out, /Hermes plugin installed/, 'reports the Hermes plugin installed');
  assert.match(out, /reload-mcp/, 'points the user at /reload-mcp to load the ours tools');
  // No regression: Claude + Codex still install in the same run.
  assert.match(calls, /claude plugin install ours@ours\.network/, 'claude still installs');
  assert.match(calls, /codex plugin add ours@ours-codex-marketplace/, 'codex still installs');
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
  assert.match(out, /No Claude Code, Codex, or Hermes found/, 'says no harness is present');
  assert.match(out, /Install one of them first/, 'tells the user what to do');
  assert.doesNotMatch(calls, /plugin/, 'no plugin work without a harness');
  assert.doesNotMatch(calls, /ours-fleet init/, 'bails before the later steps');
  rmSync(tmp, { recursive: true, force: true });
});

// --- Ctrl+C at a prompt must abort cleanly (exit 130 + message), never hang -------------------
// Needs a real pty (a prompt only blocks with a controlling terminal); skipped without python3.
function hasPython3() {
  try { execFileSync('python3', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}
const PTY_SIGINT = `
import os, pty, sys, time, select
env=dict(os.environ); env["OURS_INSTALL_DRY_RUN"]="1"; env["NO_COLOR"]="1"; env.pop("OURS_ASSUME_YES",None)
pid,fd=pty.fork()
if pid==0: os.execvpe("node",["node",sys.argv[1]],env); os._exit(127)
buf=b""
def drain(t=0.8):
    global buf; end=time.time()+t
    while time.time()<end:
        r,_,_=select.select([fd],[],[],0.1)
        if r:
            try:d=os.read(fd,4096)
            except OSError:break
            if not d:break
            buf+=d
        elif buf and buf.rstrip().endswith(b"[Enter]"):break
# wait for the first prompt, then send Ctrl+C
for _ in range(40):
    drain(0.3)
    if b"Continue?" in buf: break
os.write(fd,b"\\x03"); time.sleep(0.3); drain(1.5)
st=None
for _ in range(40):
    try: w,s=os.waitpid(pid,os.WNOHANG)
    except ChildProcessError: st="reaped";break
    if w: st=s;break
    drain(0.15); time.sleep(0.1)
tail=buf.decode(errors="replace")
if "cancelled" in tail.lower(): print("MSG_OK")
if st is None: print("HUNG")
elif st=="reaped": print("EXIT_UNKNOWN")
elif os.WIFEXITED(st): print("EXIT", os.WEXITSTATUS(st))
elif os.WIFSIGNALED(st): print("SIGNAL", os.WTERMSIG(st))
`;
// A hermetic env for the pty tests: fake bins on PATH so the flow REACHES prompts on any machine
// (a clean CI runner has no claude/codex/ours-mcp, so without this the installer would take the
// "no harness" early-exit and never prompt). Returns { env, tmp }.
function ptyBins(opts = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'installer-'));
  const bin = join(tmp, 'bin');
  mkdirSync(bin, { recursive: true });
  const log = join(tmp, 'calls.log');
  writeFileSync(log, '');
  fakeBins(bin, { daemon: 'installed', ...opts });
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('OURS_')),
  );
  return {
    tmp,
    env: {
      ...inherited,
      PATH: `${bin}:${process.env.PATH}`,
      CALLLOG: log,
      HOME: tmp,
      SHELL: '/bin/bash',
      OURS_CONFIG: join(tmp, '.ours', 'config.json'),
      OURS_STATE_DIR: join(tmp, '.ours'),
    },
  };
}

test('Ctrl+C at a prompt aborts cleanly (exit 130 + message), never hangs',
  { skip: hasPython3() ? false : 'python3 not available for pty' }, () => {
  const { env, tmp } = ptyBins();
  const out = execFileSync('python3', ['-c', PTY_SIGINT, INSTALL_MJS], { encoding: 'utf8', timeout: 60_000, env });
  assert.match(out, /MSG_OK/, 'prints a friendly cancellation message');
  assert.match(out, /EXIT 130/, 'exits with code 130, not a hang or a bare signal kill');
  assert.doesNotMatch(out, /HUNG/, 'must never hang after Ctrl+C');
  rmSync(tmp, { recursive: true, force: true });
});

// A full interactive happy-path run must TERMINATE on its own after the summary (the owner hit a
// hang at the end). Drive Enter through every prompt in a pty and assert a clean exit 0.
const PTY_HAPPY = `
import os, pty, sys, time, select
env=dict(os.environ); env["OURS_INSTALL_DRY_RUN"]="1"; env["NO_COLOR"]="1"; env.pop("OURS_ASSUME_YES",None)
pid,fd=pty.fork()
if pid==0: os.execvpe("node",["node",sys.argv[1]],env); os._exit(127)
buf=b""; last=time.time()
def pump():
    global buf,last
    r,_,_=select.select([fd],[],[],0.4)
    if r:
        try:d=os.read(fd,4096)
        except OSError:return False
        if not d:return False
        buf+=d; last=time.time()
        # every prompt ends with a bracket/colon then a space; answer with Enter and reset
        if buf.endswith((b"] ", b": ")):
            os.write(fd,b"\\n"); time.sleep(0.05); buf=b""
    return True
st=None
for _ in range(600):
    try: w,s=os.waitpid(pid,os.WNOHANG)
    except ChildProcessError: st="reaped";break
    if w: st=s;break
    if not pump():
        if time.time()-last>4: break
print("EXIT", os.WEXITSTATUS(st)) if isinstance(st,int) and os.WIFEXITED(st) else print("NOEXIT", st)
`;
test('a full happy-path run terminates on its own after the summary (no end-hang)',
  { skip: hasPython3() ? false : 'python3 not available for pty' }, () => {
  const { env, tmp } = ptyBins();
  const out = execFileSync('python3', ['-c', PTY_HAPPY, INSTALL_MJS], { encoding: 'utf8', timeout: 90_000, env });
  assert.match(out, /EXIT 0/, 'the installer exits cleanly on its own after the final summary');
  rmSync(tmp, { recursive: true, force: true });
});

const PTY_VOICE_DECLINE = `
import os, pty, sys, time, select
env=dict(os.environ); env["OURS_INSTALL_DRY_RUN"]="1"; env["NO_COLOR"]="1"; env.pop("OURS_ASSUME_YES",None)
pid,fd=pty.fork()
if pid==0: os.execvpe("node",["node",sys.argv[1]],env); os._exit(127)
buf=b""; pending=b""; last=time.time(); st=None
for _ in range(900):
    try:w,s=os.waitpid(pid,os.WNOHANG)
    except ChildProcessError:st="reaped";break
    if w:st=s;break
    r,_,_=select.select([fd],[],[],0.25)
    if r:
        try:d=os.read(fd,4096)
        except OSError:break
        if not d:break
        buf+=d; pending+=d; last=time.time()
        if pending.endswith((b"] ", b": ")):
            reply=b"n\\n" if b"Set up voice transcription now?" in pending[-500:] else b"\\n"
            os.write(fd,reply); pending=b""
    elif time.time()-last>8:break
if st is None:
    for _ in range(40):
        try:w,s=os.waitpid(pid,os.WNOHANG)
        except ChildProcessError:st="reaped";break
        if w:st=s;break
        time.sleep(0.05)
text=buf.decode(errors="replace")
print("EXIT",os.WEXITSTATUS(st)) if isinstance(st,int) and os.WIFEXITED(st) else print("NOEXIT",st)
print("DECLINE_OK" if "declined; offered again on re-run" in text else "DECLINE_MISSING")
`;
test('interactive voice setup can be declined without changing config and is offered on rerun',
  { skip: hasPython3() ? false : 'python3 not available for pty' }, () => {
  const { tmp, env } = ptyBins();
  const out = execFileSync('python3', ['-c', PTY_VOICE_DECLINE, INSTALL_MJS], {
    encoding: 'utf8', timeout: 120_000, env,
  });
  assert.match(out, /EXIT 0/);
  assert.match(out, /DECLINE_OK/);
  assert.equal(existsSync(join(tmp, '.ours', 'config.json')), false, 'decline does not create a voice config');
  rmSync(tmp, { recursive: true, force: true });
});

// Drive a FIRST install through the voice offer and prove the installer delegates to the canonical
// ours-mcp command instead of maintaining a second provider/token implementation.
const PTY_VOICE_DELEGATED = `
import os, pty, sys, time, select
env=dict(os.environ); env.pop("OURS_INSTALL_DRY_RUN",None); env["NO_COLOR"]="1"; env.pop("OURS_ASSUME_YES",None)
pid,fd=pty.fork()
if pid==0: os.execvpe("node",["node",sys.argv[1]],env); os._exit(127)
buf=b""; pending=b""; last=time.time(); st=None
def answer():
    global pending
    if not pending.endswith((b"] ", b": ")): return
    os.write(fd,b"\\n"); pending=b""
for _ in range(900):
    try: w,s=os.waitpid(pid,os.WNOHANG)
    except ChildProcessError: st="reaped";break
    if w: st=s;break
    r,_,_=select.select([fd],[],[],0.25)
    if r:
        try:d=os.read(fd,4096)
        except OSError:break
        if not d:break
        buf+=d; pending+=d; last=time.time(); answer()
    elif time.time()-last>8: break
if st is None:
    for _ in range(40):
        try:w,s=os.waitpid(pid,os.WNOHANG)
        except ChildProcessError:st="reaped";break
        if w:st=s;break
        time.sleep(0.05)
text=buf.decode(errors="replace")
print("EXIT", os.WEXITSTATUS(st)) if isinstance(st,int) and os.WIFEXITED(st) else print("NOEXIT",st)
print("DELEGATED" if "canonical ours-mcp voice-setup completed" in text else "DELEGATION_MISSING")
`;
test('fresh interactive install delegates voice credentials to the canonical ours-mcp command',
  { skip: hasPython3() ? false : 'python3 not available for pty' }, () => {
  const { tmp, env } = ptyBins();
  // Make the fake daemon initially absent so this is the fresh-install path.
  fakeBins(join(tmp, 'bin'), { daemon: 'absent' });
  const out = execFileSync('python3', ['-c', PTY_VOICE_DELEGATED, INSTALL_MJS], {
    encoding: 'utf8', timeout: 120_000, env,
  });
  assert.match(out, /EXIT 0/);
  assert.match(out, /DELEGATED/);
  const calls = readFileSync(join(tmp, 'calls.log'), 'utf8');
  const voiceAt = calls.indexOf('ours-mcp voice-setup');
  const startAt = calls.indexOf('ours-mcp start');
  assert.ok(voiceAt >= 0, 'canonical voice setup ran');
  assert.ok(startAt > voiceAt, 'fresh install configures voice before the daemon first starts');
  assert.equal(calls.match(/^ours-mcp start$/gm)?.length, 1, 'fresh install starts the daemon exactly once');
  assert.doesNotMatch(calls, /^ours-mcp restart$/m, 'fresh install never restarts before or after first start');
  assert.doesNotMatch(readFileSync(INSTALL_MJS, 'utf8'), /askSecret|Provider \(openai-compatible/,
    'installer contains no duplicate credential prompt implementation');
  rmSync(tmp, { recursive: true, force: true });
});

const PTY_UPDATE_WITH_VOICE = `
import os, pty, sys, time, select
mode=sys.argv[2]
env=dict(os.environ); env.pop("OURS_INSTALL_DRY_RUN",None); env["NO_COLOR"]="1"; env.pop("OURS_ASSUME_YES",None)
pid,fd=pty.fork()
if pid==0: os.execvpe("node",["node",sys.argv[1]],env); os._exit(127)
buf=b""; pending=b""; last=time.time(); st=None
for _ in range(900):
    try:w,s=os.waitpid(pid,os.WNOHANG)
    except ChildProcessError:st="reaped";break
    if w:st=s;break
    r,_,_=select.select([fd],[],[],0.25)
    if r:
        try:d=os.read(fd,4096)
        except OSError:break
        if not d:break
        buf+=d; pending+=d; last=time.time()
        if pending.endswith((b"] ", b": ")):
            tail=pending[-700:]
            if b"check for an update now?" in tail: reply=b"y\\n"
            elif mode=="decline" and b"Set up voice transcription now?" in tail: reply=b"n\\n"
            else: reply=b"\\n"
            os.write(fd,reply); pending=b""
    elif time.time()-last>8:break
if st is None:
    for _ in range(40):
        try:w,s=os.waitpid(pid,os.WNOHANG)
        except ChildProcessError:st="reaped";break
        if w:st=s;break
        time.sleep(0.05)
text=buf.decode(errors="replace")
print("EXIT",os.WEXITSTATUS(st)) if isinstance(st,int) and os.WIFEXITED(st) else print("NOEXIT",st)
print("EXTERNAL_HANDOFF" if "restart its external launcher to load the update" in text else "NO_EXTERNAL_HANDOFF")
`;
test('update asks/configures voice before one restart and suppresses the normal update restart',
  { skip: hasPython3() ? false : 'python3 not available for pty' }, () => {
  const { tmp, env } = ptyBins({ updateVersion: true, voiceRestartTrace: true });
  const out = execFileSync('python3', ['-c', PTY_UPDATE_WITH_VOICE, INSTALL_MJS, 'accept'], {
    encoding: 'utf8', timeout: 120_000, env,
  });
  assert.match(out, /EXIT 0/);
  const calls = readFileSync(join(tmp, 'calls.log'), 'utf8');
  const selectedAt = calls.indexOf('voice-provider-selected');
  const configuredAt = calls.indexOf('voice-config-written');
  const restartAt = calls.indexOf('ours-mcp restart (voice-setup)');
  assert.ok(selectedAt >= 0 && configuredAt > selectedAt, 'provider selection precedes config write');
  assert.ok(restartAt > configuredAt, 'provider prompt/config precede the canonical restart');
  assert.equal(calls.match(/^ours-mcp restart \(voice-setup\)$/gm)?.length, 1,
    'accepted voice setup owns exactly one restart');
  assert.doesNotMatch(calls, /^ours-mcp restart$/m,
    'installer does not add a redundant update restart after canonical voice setup');
  rmSync(tmp, { recursive: true, force: true });
});

test('stopped-daemon update configures voice then preserves one normal update restart',
  { skip: hasPython3() ? false : 'python3 not available for pty' }, () => {
  const { tmp, env } = ptyBins({ updateVersion: true, daemonState: 'stopped' });
  const out = execFileSync('python3', ['-c', PTY_UPDATE_WITH_VOICE, INSTALL_MJS, 'accept'], {
    encoding: 'utf8', timeout: 120_000, env,
  });
  assert.match(out, /EXIT 0/);
  assert.match(out, /NO_EXTERNAL_HANDOFF/, 'stopped daemon remains installer-managed');
  const calls = readFileSync(join(tmp, 'calls.log'), 'utf8');
  const configuredAt = calls.indexOf('ours-mcp voice-setup');
  const restartAt = calls.indexOf('ours-mcp restart');
  assert.ok(configuredAt >= 0, 'canonical voice setup ran while the daemon was stopped');
  assert.ok(restartAt > configuredAt, 'the normal update restart follows config-only voice setup');
  assert.equal(calls.match(/^ours-mcp restart$/gm)?.length, 1,
    'stopped update keeps exactly one normal update restart');
  assert.doesNotMatch(calls, /^ours-mcp restart \(voice-setup\)$/m,
    'stopped canonical setup does not claim a managed restart');
  rmSync(tmp, { recursive: true, force: true });
});

test('external-daemon update leaves restart ownership with the external launcher',
  { skip: hasPython3() ? false : 'python3 not available for pty' }, () => {
  const { tmp, env } = ptyBins({ updateVersion: true, daemonState: 'external' });
  const out = execFileSync('python3', ['-c', PTY_UPDATE_WITH_VOICE, INSTALL_MJS, 'accept'], {
    encoding: 'utf8', timeout: 120_000, env,
  });
  assert.match(out, /EXIT 0/);
  assert.match(out, /EXTERNAL_HANDOFF/, 'operator receives the external-launcher restart handoff');
  const calls = readFileSync(join(tmp, 'calls.log'), 'utf8');
  assert.match(calls, /^ours-mcp voice-setup$/m, 'canonical config-only voice setup ran');
  assert.doesNotMatch(calls, /^ours-mcp restart(?: \(voice-setup\))?$/m,
    'installer does not seize restart ownership from an external launcher');
  rmSync(tmp, { recursive: true, force: true });
});

test('voice restart/readiness rollback signal suppresses a redundant installer restart loop',
  { skip: hasPython3() ? false : 'python3 not available for pty' }, () => {
  const { tmp, env } = ptyBins({
    updateVersion: true,
    voiceRestartTrace: true,
    voiceRecoveryFailure: true,
  });
  const out = execFileSync('python3', ['-c', PTY_UPDATE_WITH_VOICE, INSTALL_MJS, 'accept'], {
    encoding: 'utf8', timeout: 120_000, env,
  });
  assert.match(out, /EXIT 0/);
  const calls = readFileSync(join(tmp, 'calls.log'), 'utf8');
  assert.equal(calls.match(/^ours-mcp restart \(voice-setup\)$/gm)?.length, 1,
    'canonical recovery transaction is the only restart owner');
  assert.doesNotMatch(calls, /^ours-mcp restart$/m,
    'installer does not create a restart/rollback/restart loop after exit 2');
  rmSync(tmp, { recursive: true, force: true });
});

test('declined or already-ready voice preserves one normal update restart',
  { skip: hasPython3() ? false : 'python3 not available for pty' }, () => {
  for (const mode of ['decline', 'ready']) {
    const { tmp, env } = ptyBins({ updateVersion: true, voiceRestartTrace: true });
    if (mode === 'ready') {
      mkdirSync(join(tmp, '.ours'), { recursive: true });
      writeFileSync(join(tmp, '.ours', 'config.json'), JSON.stringify({
        port: 3050,
        stt: { provider: 'deepgram', apiKey: 'ordering-placeholder-secret' },
      }, null, 2) + '\n', { mode: 0o600 });
      env.OURS_CONFIG = join(tmp, '.ours', 'config.json');
    }
    const out = execFileSync('python3', ['-c', PTY_UPDATE_WITH_VOICE, INSTALL_MJS, mode], {
      encoding: 'utf8', timeout: 120_000, env,
    });
    assert.match(out, /EXIT 0/, `${mode} flow exits`);
    const calls = readFileSync(join(tmp, 'calls.log'), 'utf8');
    assert.equal(calls.match(/^ours-mcp restart$/gm)?.length, 1,
      `${mode} flow keeps exactly one normal update restart`);
    assert.doesNotMatch(calls, /^ours-mcp restart \(voice-setup\)$/m,
      `${mode} flow does not invoke the voice transaction restart`);
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ===============================================================================================
// ONE SHARED DAEMON — the Telegram connector must be handed THIS install's daemon.
//
// The connector keeps its own config file and never inherits ~/.ours/config.json: with no
// overrides its SDK reports configPath: null and falls back to the built-in 127.0.0.1:3050, so a
// daemon on any other port is missed entirely. Pointing it with an endpoint ALONE is refused
// (INCOHERENT_SELECTION: "the endpoint was selected … but the state directory is the built-in
// default") because the daemon's API token belongs to a state directory. Endpoint AND state dir
// together is the only selection the SDK accepts — verified directly against the published
// @ours.network/sdk 0.1.2 that tg-connector 0.3.3-nightly.1 pins.
//
// These run on a FRESH isolated config/state root (HOME + OURS_CONFIG under a fresh mkdtemp) and
// answer Yes to Telegram, which the non-interactive path cannot do (its default is No).
// ===============================================================================================
const PTY_TELEGRAM = `
import os, pty, sys, time, select
env=dict(os.environ); env["NO_COLOR"]="1"; env.pop("OURS_ASSUME_YES",None); env.pop("OURS_INSTALL_DRY_RUN",None)
broker=os.environ.get("ANSWER_BROKER","")
tg=os.environ.get("ANSWER_TELEGRAM","y")            # install the Telegram connector?
tg_dedicated=os.environ.get("ANSWER_TG_DEDICATED","")  # give Telegram its OWN daemon?
rooms_dedicated=os.environ.get("ANSWER_ROOMS_DEDICATED","")  # give Rooms its OWN daemon?
rooms=os.environ.get("ANSWER_ROOMS","")             # install Rooms (ours-cowork)?
# Port answers are keyed by WHICH daemon is being asked about, not by position: a re-run
# skips the shared daemon's question entirely, so a positional list would shift.
port_shared=os.environ.get("ANSWER_PORT_SHARED","")
port_tg=os.environ.get("ANSWER_PORT_TG","")
port_rooms=os.environ.get("ANSWER_PORT_ROOMS","")
port_rooms_daemon=os.environ.get("ANSWER_PORT_ROOMS_DAEMON","")
pid,fd=pty.fork()
if pid==0: os.execvpe("node",["node",sys.argv[1]],env); os._exit(127)
buf=b""; pending=b""; last=time.time(); st=None
def step(buf):
    # Which component's step are we in? The last heading printed wins, so the shared
    # "Install it?" prompt is answered for the right component.
    marks={"fleet":buf.rfind(b"ours-fleet (your always-online"),
           "telegram":buf.rfind(b"Telegram connector"),
           "rooms":buf.rfind(b"Rooms (ours-cowork)")}
    best=max(marks,key=lambda k:marks[k])
    return best if marks[best]>=0 else ""
for _ in range(1500):
    try: w,s=os.waitpid(pid,os.WNOHANG)
    except ChildProcessError: st="reaped"; break
    if w: st=s; break
    r,_,_=select.select([fd],[],[],0.25)
    if r:
        try: d=os.read(fd,4096)
        except OSError: break
        if not d: break
        buf+=d; pending+=d; last=time.time()
        if pending.endswith((b"] ", b": ")):
            tail=pending[-800:]
            here=step(buf)
            if b"custom broker address?" in tail and broker: reply=b"y\\n"
            elif b"Enter the broker address" in tail and broker: reply=broker.encode()+b"\\n"
            elif b"should the shared daemon use" in tail:
                reply=(port_shared.encode()+b"\\n") if port_shared else b"\\n"
            elif b"should the Telegram daemon use" in tail:
                reply=(port_tg.encode()+b"\\n") if port_tg else b"\\n"
            elif b"should the Rooms console use" in tail:
                reply=(port_rooms.encode()+b"\\n") if port_rooms else b"\\n"
            elif b"should the Rooms daemon use" in tail:
                reply=(port_rooms_daemon.encode()+b"\\n") if port_rooms_daemon else b"\\n"
            elif b"OWN dedicated daemon?" in tail and here=="rooms": reply=(b"y\\n" if rooms_dedicated else b"\\n")
            elif b"OWN dedicated daemon?" in tail: reply=(b"y\\n" if tg_dedicated else b"\\n")
            elif b"Install it?" in tail and here=="telegram": reply=(b"y\\n" if tg else b"\\n")
            elif b"Install it?" in tail and here=="rooms": reply=(b"y\\n" if rooms else b"\\n")
            elif b"starts automatically on boot" in tail: reply=b"y\\n"
            else: reply=b"\\n"
            os.write(fd,reply); pending=b""
    elif time.time()-last>10: break
if st is None:
    for _ in range(60):
        try: w,s=os.waitpid(pid,os.WNOHANG)
        except ChildProcessError: st="reaped"; break
        if w: st=s; break
        time.sleep(0.05)
sys.stdout.write(buf.decode(errors="replace"))
print("\\n---EXIT", (os.WEXITSTATUS(st) if isinstance(st,int) and os.WIFEXITED(st) else st))
`;

// A fresh isolated root: its own HOME, its own OURS_CONFIG, its own fake bins. Returns a
// `run()` that can be called repeatedly against the SAME root (for idempotency).
function isolatedRoot(opts = {}, extraEnv = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'installer-tg-'));
  const bin = join(tmp, 'bin');
  mkdirSync(bin, { recursive: true });
  const log = join(tmp, 'calls.log');
  writeFileSync(log, '');
  fakeBins(bin, opts);
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('OURS_') && !key.startsWith('ANSWER_')),
  );
  const env = {
    ...inherited,
    PATH: `${bin}:${process.env.PATH}`,
    CALLLOG: log,
    HOME: tmp,
    SHELL: '/bin/bash',
    OURS_CONFIG: join(tmp, '.ours', 'config.json'),
    OURS_STATE_DIR: join(tmp, '.ours'),
    ...extraEnv,
  };
  const run = (installer = INSTALL_MJS) => ({
    out: execFileSync('python3', ['-c', PTY_TELEGRAM, installer], { encoding: 'utf8', timeout: 180_000, env }),
    calls: readFileSync(log, 'utf8'),
  });
  return { tmp, bin, log, env, run };
}

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

test('fresh isolated root: the Telegram connector is pointed at THIS daemon before its service is installed',
  { skip: hasPython3() ? false : 'python3 not available for pty' }, () => {
  const root = isolatedRoot({ daemon: 'absent' }, { ANSWER_BROKER: 'wss://broker.example.test' });
  const { out, calls } = root.run();
  assert.match(out, /---EXIT 0/, 'the run completes cleanly');

  // The daemon this install actually built (the port is probe-dependent, so read it back).
  const daemonCfg = readJson(join(root.tmp, '.ours', 'config.json'));
  assert.ok(Number.isInteger(daemonCfg.port), 'daemon config carries a numeric port');
  assert.equal(daemonCfg.brokerUrl, 'wss://broker.example.test', 'daemon took the custom broker');

  // The connector's OWN config now names that exact daemon.
  const tgPath = join(root.tmp, '.ours-telegram', 'config.json');
  assert.ok(existsSync(tgPath), 'the installer writes the connector config it would otherwise never get');
  const tg = readJson(tgPath);
  assert.equal(tg.daemonUrl, `http://127.0.0.1:${daemonCfg.port}`,
    'connector points at THIS daemon, not the SDK built-in 127.0.0.1:3050');
  assert.equal(tg.daemonStateDir, join(root.tmp, '.ours'),
    'the state directory is selected too — an endpoint alone is refused by the SDK guard');
  assert.equal(tg.brokerUrl, 'wss://broker.example.test',
    'a pre-0.3.3 connector, which meets the daemon at a broker instead, gets the same broker');
  assert.equal(statSync(tgPath).mode & 0o777, 0o600, 'written 0600 like every other ours config');

  // ORDERING: install-service bakes what it resolves into the unit, so the config had to exist
  // BEFORE it ran. The fake snapshots the file at that moment.
  assert.match(calls, /ours-tg-connector install-service/, 'the connector service was installed');
  const snapshot = `${root.log}.tgsnapshot`;
  assert.ok(existsSync(snapshot), 'the connector config already existed when install-service ran');
  assert.deepEqual(readJson(snapshot), tg, 'install-service saw the final daemon selection, not a later one');

  // Still exactly ONE daemon: nothing in the run starts a second one.
  assert.equal(calls.match(/^ours-mcp start$/gm)?.length, 1, 'the daemon is started exactly once');
  assert.doesNotMatch(calls, /ours-tg-connector (start|serve)/, 'the connector never starts a daemon of its own');
  rmSync(root.tmp, { recursive: true, force: true });
});

test('idempotent re-run: an unchanged daemon selection rewrites nothing',
  { skip: hasPython3() ? false : 'python3 not available for pty' }, () => {
  const root = isolatedRoot({ daemon: 'absent' });
  root.run();
  const tgPath = join(root.tmp, '.ours-telegram', 'config.json');
  const first = readFileSync(tgPath, 'utf8');
  // Keep a user-added key to prove a re-run preserves what it does not own.
  writeFileSync(tgPath, JSON.stringify({ ...JSON.parse(first), sttModel: 'user-chosen' }, null, 2) + '\n', { mode: 0o600 });
  const second = root.run();
  assert.match(second.out, /already points at this daemon/, 'the re-run reports no change instead of rewriting');
  const after = readJson(tgPath);
  assert.equal(after.sttModel, 'user-chosen', 'keys the installer does not own survive a re-run');
  assert.equal(after.daemonUrl, JSON.parse(first).daemonUrl, 'the daemon selection is unchanged');
  rmSync(root.tmp, { recursive: true, force: true });
});

// ===============================================================================================
// TOPOLOGY — the shared daemon, plus a consumer that may be given its own.
//
// The default is unchanged and must stay that way: everything shares the daemon from step 1, and
// Enter / non-interactive never provisions a second one. A dedicated daemon is only real if it is
// isolated in all three ways at once — its own port, its own state directory (the API token lives
// there) and its own boot unit (core's OURS_SERVICE_NAME; without it `install-service` overwrites
// the shared daemon's unit, which is the collision this whole feature exists to prevent).
// ===============================================================================================

test('default topology: every consumer shares the one daemon and no second daemon is provisioned',
  { skip: hasPython3() ? false : 'python3 not available for pty' }, () => {
  const root = isolatedRoot({ daemon: 'absent' });
  const { out, calls } = root.run();
  assert.match(out, /---EXIT 0/);
  assert.match(out, /Telegram will use the shared daemon on port \d+/, 'the shared daemon is the default answer');
  // Nothing was driven with a dedicated daemon's environment.
  assert.doesNotMatch(calls, /ours-mcp-env/, 'no daemon was started with an instance name');
  assert.ok(!existsSync(join(root.tmp, '.ours-tg')), 'no dedicated state directory created');
  assert.equal(calls.match(/^ours-mcp start$/gm)?.length, 1, 'exactly one daemon');
  const tg = readJson(join(root.tmp, '.ours-telegram', 'config.json'));
  assert.equal(tg.daemonStateDir, join(root.tmp, '.ours'), 'the connector points at the SHARED state dir');
  rmSync(root.tmp, { recursive: true, force: true });
});

test('dedicated Telegram daemon: its own port, state dir and boot unit — and the connector is wired to it',
  { skip: hasPython3() ? false : 'python3 not available for pty' }, () => {
  // Port answers, in the order the installer asks: shared daemon (Enter → default), then the
  // dedicated Telegram daemon (an explicit, distinct port).
  const root = isolatedRoot({ daemon: 'absent' }, { ANSWER_TG_DEDICATED: '1', ANSWER_PORT_TG: '3077' });
  const { out, calls } = root.run();
  assert.match(out, /---EXIT 0/, 'the run completes cleanly');

  const sharedCfg = readJson(join(root.tmp, '.ours', 'config.json'));
  const dedicatedPath = join(root.tmp, '.ours-tg', 'config.json');
  assert.ok(existsSync(dedicatedPath), 'the dedicated daemon got its own config file');
  const dedicated = readJson(dedicatedPath);

  // 1. Its own port — and never the shared daemon's.
  assert.equal(dedicated.port, 3077);
  assert.notEqual(dedicated.port, sharedCfg.port, 'two daemons never share a port');
  // 2. Its own state directory — the daemon API token lives there, so sharing one would
  //    hand the connector a token that belongs to a different daemon.
  assert.equal(dedicated.stateDir, join(root.tmp, '.ours-tg'));
  assert.notEqual(dedicated.stateDir, join(root.tmp, '.ours'));
  // 3. Its own boot unit — without this, install-service overwrites the shared daemon's.
  assert.equal(dedicated.serviceName, 'tg');
  assert.match(calls, /ours-mcp-env install-service service=tg /, 'its service was installed under its own name');
  assert.match(calls, /ours-mcp-env start service=tg /, 'and it was started as itself');
  assert.match(calls, new RegExp(`ours-mcp-env install-service service=tg config=${dedicatedPath} state=${join(root.tmp, '.ours-tg')}`),
    'the dedicated daemon is driven entirely through its own config + state');
  // The shared daemon's own service install carried NO instance name, so its unit is untouched.
  assert.match(calls, /^ours-mcp install-service$/m, 'the shared daemon still installs the default unit');

  // The connector is wired to the DEDICATED daemon, endpoint and state dir together.
  const tg = readJson(join(root.tmp, '.ours-telegram', 'config.json'));
  assert.equal(tg.daemonUrl, 'http://127.0.0.1:3077');
  assert.equal(tg.daemonStateDir, join(root.tmp, '.ours-tg'));
  assert.notEqual(tg.daemonUrl, `http://127.0.0.1:${sharedCfg.port}`);
  // Both daemons still meet the deployment at the same broker.
  assert.equal(dedicated.brokerUrl, tg.brokerUrl, 'one broker across the topology');
  // And install-service saw the final selection, not a later one.
  assert.deepEqual(readJson(`${root.log}.tgsnapshot`), tg);
  assert.match(out, /Dedicated Telegram daemon ready on port 3077/);
  rmSync(root.tmp, { recursive: true, force: true });
});

test('a dedicated daemon may not take the port the shared daemon just claimed',
  { skip: hasPython3() ? false : 'python3 not available for pty' }, () => {
  // Both port questions answered 3081. Nothing is LISTENING on it yet — the shared daemon
  // is only configured, not really running — so a bind probe cannot catch this. Only the
  // in-run ledger can, which is exactly the duplicate case it exists for.
  const root = isolatedRoot({ daemon: 'absent' }, { ANSWER_TG_DEDICATED: '1', ANSWER_PORT_SHARED: '3081', ANSWER_PORT_TG: '3081' });
  const { out } = root.run();
  assert.match(out, /---EXIT 0/);
  assert.match(out, /already being used by another daemon in this install/, 'the collision is named plainly');
  const sharedPort = readJson(join(root.tmp, '.ours', 'config.json')).port;
  const dedicatedPort = readJson(join(root.tmp, '.ours-tg', 'config.json')).port;
  assert.equal(sharedPort, 3081, 'the first answer stands');
  assert.notEqual(dedicatedPort, sharedPort, 'the second is moved off it, never silently persisted');
  rmSync(root.tmp, { recursive: true, force: true });
});

test('dedicated daemon re-run is idempotent — an unchanged selection rewrites nothing',
  { skip: hasPython3() ? false : 'python3 not available for pty' }, () => {
  const root = isolatedRoot({ daemon: 'absent' }, { ANSWER_TG_DEDICATED: '1', ANSWER_PORT_TG: '3079' });
  root.run();
  const dedicatedPath = join(root.tmp, '.ours-tg', 'config.json');
  const first = readJson(dedicatedPath);
  assert.equal(first.port, 3079);
  const second = root.run();
  assert.match(second.out, /already configured on port 3079 — no change/, 'the re-run reports no change');
  assert.deepEqual(readJson(dedicatedPath), first, 'and the file is byte-for-byte the same selection');
  rmSync(root.tmp, { recursive: true, force: true });
});

// ===============================================================================================
// ROOMS (ours-cowork) — its own surface (broker, private state dir, console port) AND which daemon
// it runs against. cowork PR #9 added an external mode, so Rooms answers the same
// common-vs-dedicated question Telegram does, plus a third state Telegram has no use for:
// EMBEDDED, cowork's own daemon, which is what every pre-#9 install runs.
//
// Contract: optional `daemon` block; absent ⇒ embedded; external ⇒
// { mode:'external', endpoint, stateDir } and BOTH halves are required, because cowork holds no
// token and its SDK reads <stateDir>/daemon-token. Boot is fail-closed with no embedded fallback,
// so a config that is already embedded must never be migrated unasked.
// ===============================================================================================

test('Rooms is an explicit step, skipped by default, and never installed non-interactively', () => {
  const { out, calls, tmp } = runInstall({ daemon: 'absent' });
  assert.match(out, /5\/5 — Rooms \(ours-cowork\)/, 'Rooms is a visible step of its own');
  assert.doesNotMatch(calls, /npm i -g @ours\.network\/cowork/, 'default No — nothing installed');
  assert.doesNotMatch(calls, /ours-cowork/, 'and its CLI is never driven');
  assert.match(out, /Rooms \(ours-cowork\).*skipped/, 'the summary says so');
  assert.doesNotMatch(out, /Set up my first Rooms mission room/, 'a skipped Rooms drops out of the hand-off');
  rmSync(tmp, { recursive: true, force: true });
});

test('stable channel: Rooms installs cowork@latest and stays EMBEDDED — no block a pre-#9 build cannot honour',
  { skip: hasPython3() ? false : 'python3 not available for pty' }, () => {
  // cowork's config is a strict document and its boot is fail-closed, so a `daemon` block
  // written for a build that predates the external mode breaks Rooms rather than degrading it.
  const root = isolatedRoot({ daemon: 'absent' }, { ANSWER_ROOMS: '1', ANSWER_TELEGRAM: '', ANSWER_PORT_ROOMS: '3066' });
  const { out, calls } = root.run();
  assert.match(out, /---EXIT 0/);
  assert.match(calls, /npm i -g @ours\.network\/cowork@latest/, 'the stable channel installs stable cowork');
  const cfg = readJson(join(root.tmp, '.ours-cowork', 'config.json'));
  assert.equal(cfg.rest.port, 3066, 'its own surface is still configured');
  assert.equal(cfg.daemon, undefined, 'and NO daemon block is written');
  assert.match(out, /needs a newer/, 'the reason is stated plainly');
  assert.match(out, /OURS_CHANNEL=nightly/, 'with the exact way to get it');
  rmSync(root.tmp, { recursive: true, force: true });
});

test('nightly channel: Rooms installs cowork@nightly and is wired to the shared daemon in its external shape',
  { skip: hasPython3() ? false : 'python3 not available for pty' }, () => {
  // Port answers in order: shared daemon (Enter), Rooms console (explicit).
  const root = isolatedRoot(
    { daemon: 'absent' },
    { ANSWER_ROOMS: '1', ANSWER_TELEGRAM: '', ANSWER_PORT_ROOMS: '3062', ANSWER_BROKER: 'wss://broker.example.test',
      OURS_CHANNEL: 'nightly' },
  );
  const { out, calls } = root.run();
  assert.match(out, /---EXIT 0/);

  // cowork publishes `nightly` alongside every other service, and the external-daemon mode
  // ships on that line.
  assert.match(calls, /npm i -g @ours\.network\/cowork@nightly/, 'rooms follows the nightly channel');
  assert.doesNotMatch(calls, /@ours\.network\/cowork@(latest|next)/, 'no stable, and no historical `next` tag');
  // And the rest of the nightly stack is coherent with it.
  assert.match(calls, /npm i -g @ours\.network\/fleet@nightly/, 'fleet follows the channel');
  assert.match(calls, /npm i -g @ours\.network\/mcp@nightly/);

  const cfg = readJson(join(root.tmp, '.ours-cowork', 'config.json'));
  assert.equal(cfg.version, 1, "cowork's config is a versioned strict document");
  assert.equal(cfg.brokerUrl, 'wss://broker.example.test', 'Rooms shares the deployment broker');
  assert.equal(cfg.stateDir, join(root.tmp, '.ours-cowork'), 'its own private state directory');
  assert.equal(cfg.rest.port, 3062, 'the console port the user chose');
  assert.equal(cfg.rest.enabled, true);

  // Default daemon answer is COMMON, written in cowork's exact external shape.
  const sharedPort = readJson(join(root.tmp, '.ours', 'config.json')).port;
  assert.equal(cfg.daemon.mode, 'external');
  assert.equal(cfg.daemon.endpoint, `http://127.0.0.1:${sharedPort}`, 'pointed at THIS install\'s shared daemon');
  // daemon.stateDir is the OURS daemon's state dir (where daemon-token lives) — NOT cowork's own.
  assert.equal(cfg.daemon.stateDir, join(root.tmp, '.ours'));
  assert.notEqual(cfg.daemon.stateDir, cfg.stateDir, 'the two stateDir keys are not confused');
  // cowork holds no token: the installer must never write one into its config.
  assert.equal(cfg.daemon.token, undefined, 'no token is ever written — the SDK reads it from stateDir');
  assert.doesNotMatch(readFileSync(join(root.tmp, '.ours-cowork', 'config.json'), 'utf8'), /token/i,
    'the word token never appears in the Rooms config');
  assert.equal(calls.match(/^ours-mcp start$/gm)?.length, 1, 'sharing means no second daemon');

  // Ordering: install-service freezes what it resolves, so the config existed first.
  assert.match(calls, /ours-cowork install-service/, 'installed as a boot service');
  assert.deepEqual(readJson(`${root.log}.cwsnapshot`), cfg, 'install-service saw the final config');
  assert.match(out, /console at http:\/\/127\.0\.0\.1:3062\//);
  assert.match(out, /Set up my first Rooms mission room/, 'the hand-off gains its Rooms step');
  rmSync(root.tmp, { recursive: true, force: true });
});

test('Rooms re-run is idempotent and preserves keys the installer does not own',
  { skip: hasPython3() ? false : 'python3 not available for pty' }, () => {
  const root = isolatedRoot({ daemon: 'absent' }, { ANSWER_ROOMS: '1', ANSWER_TELEGRAM: '', ANSWER_PORT_ROOMS: '3063', OURS_CHANNEL: 'nightly' });
  root.run();
  const cfgPath = join(root.tmp, '.ours-cowork', 'config.json');
  const first = readJson(cfgPath);
  writeFileSync(cfgPath, JSON.stringify({ ...first, operatorNote: 'keep me' }, null, 2) + '\n', { mode: 0o600 });
  const second = root.run();
  assert.match(second.out, /already configured for this deployment/, 'an unchanged selection rewrites nothing');
  const after = readJson(cfgPath);
  assert.equal(after.operatorNote, 'keep me');
  assert.equal(after.rest.port, first.rest.port, 'the console port is unchanged on a rerun');
  assert.deepEqual(after.daemon, first.daemon, 'and so is the daemon selection');
  rmSync(root.tmp, { recursive: true, force: true });
});

test('dedicated Rooms daemon: its own port, state dir and boot unit, in cowork\'s external shape',
  { skip: hasPython3() ? false : 'python3 not available for pty' }, () => {
  const root = isolatedRoot(
    { daemon: 'absent' },
    { ANSWER_ROOMS: '1', ANSWER_ROOMS_DEDICATED: '1', ANSWER_TELEGRAM: '', ANSWER_PORT_ROOMS: '3064',
      ANSWER_PORT_ROOMS_DAEMON: '3085', OURS_CHANNEL: 'nightly' },
  );
  const { out, calls } = root.run();
  assert.match(out, /---EXIT 0/);

  const sharedCfg = readJson(join(root.tmp, '.ours', 'config.json'));
  const dedicated = readJson(join(root.tmp, '.ours-rooms', 'config.json'));
  // Three-way isolation, exactly as for Telegram — and a DIFFERENT instance from it.
  assert.equal(dedicated.port, 3085);
  assert.notEqual(dedicated.port, sharedCfg.port);
  assert.equal(dedicated.stateDir, join(root.tmp, '.ours-rooms'));
  assert.equal(dedicated.serviceName, 'rooms');
  assert.notEqual(dedicated.serviceName, 'tg', 'Rooms and Telegram never share a unit');
  assert.match(calls, /ours-mcp-env install-service service=rooms /, 'its own boot unit');
  assert.match(calls, /^ours-mcp install-service$/m, 'the shared daemon still owns the default unit');

  // cowork is pointed at THAT daemon, both halves, in the documented shape.
  const cfg = readJson(join(root.tmp, '.ours-cowork', 'config.json'));
  assert.equal(cfg.daemon.mode, 'external');
  assert.equal(cfg.daemon.endpoint, 'http://127.0.0.1:3085');
  assert.equal(cfg.daemon.stateDir, join(root.tmp, '.ours-rooms'), 'the dedicated daemon\'s state dir, where its token lives');
  assert.notEqual(cfg.daemon.stateDir, join(root.tmp, '.ours'), 'not the shared daemon\'s');
  assert.equal(cfg.stateDir, join(root.tmp, '.ours-cowork'), "cowork's OWN state dir is untouched by the daemon choice");
  assert.equal(cfg.rest.port, 3064, 'the console port is independent of the daemon port');
  // install-service freezes what it resolves, so the selection existed first.
  assert.deepEqual(readJson(`${root.log}.cwsnapshot`), cfg);
  rmSync(root.tmp, { recursive: true, force: true });
});

test('a headless run never writes a daemon block into an existing EMBEDDED Rooms install', () => {
  // Boot is fail-closed with no embedded fallback, so silently writing a daemon block into a
  // working embedded install could leave Rooms unable to start. A headless run must not do it.
  // (The branch itself is unit-tested via planCoworkConfig's three-valued `daemon` in
  // test/logic.test.mjs; this proves the end-to-end run leaves the file alone.)
  const seed = mkdtempSync(join(tmpdir(), 'installer-cw-'));
  const cwDir = join(seed, '.ours-cowork');
  mkdirSync(cwDir, { recursive: true });
  const cfgPath = join(cwDir, 'config.json');
  const embedded = { version: 1, brokerUrl: 'wss://broker1.ours.network', stateDir: cwDir, rest: { enabled: true, port: 3052 } };
  writeFileSync(cfgPath, JSON.stringify(embedded, null, 2) + '\n', { mode: 0o600 });

  const run = runInstall({ daemon: 'installed' }, { OURS_COWORK_CONFIG: cfgPath });
  assert.equal(coworkDaemonModeOf(readJson(cfgPath)), 'embedded', 'the embedded selection survives');
  assert.deepEqual(readJson(cfgPath), embedded, 'not one byte of it changed');
  assert.doesNotMatch(run.calls, /ours-cowork/, 'its CLI is never driven');
  assert.doesNotMatch(run.out, /Rooms will use the shared daemon/, 'and no daemon selection is announced');
  rmSync(seed, { recursive: true, force: true });
  rmSync(run.tmp, { recursive: true, force: true });
});

test('a failed boot-service never leaves the deployment without its one daemon', () => {
  const { out, calls, tmp } = runInstall({ daemon: 'absent', serviceFails: true });
  // install-service stops the daemon first, then fails — the installer must put it back.
  const serviceAt = calls.indexOf('ours-mcp install-service');
  assert.ok(serviceAt >= 0, 'the boot-service step ran');
  const startsAfter = calls.slice(serviceAt).match(/^ours-mcp start$/gm)?.length ?? 0;
  assert.equal(startsAfter, 1, 'the daemon is restarted after the failed boot-service step');
  assert.match(out, /boot-service not installed/, 'the boot-service failure is still reported honestly');
  assert.match(out, /ours core ready/, 'and the daemon is genuinely ready again');
  // The proof it is really up: create-root only succeeds against a running daemon.
  assert.match(out, /Your human identity/, 'the identity step runs');
  assert.doesNotMatch(out, /daemon isn't reachable/, 'the daemon is reachable for the identity step');
  assert.match(out, /running; no boot service/, 'the summary states exactly what was and was not achieved');
  rmSync(tmp, { recursive: true, force: true });
});

// --- channel: a nightly installer must build a nightly stack, a stable one must not ------------
// tg-connector's nightly is not merely newer — 0.3.2 hosts its own ADAPT wrapper while
// 0.3.3-nightly.1 attaches to the shared daemon over /api/v1, which only the SDK-based daemon
// serves. Mixing tags across that boundary is a split-brain deployment.
test('channel follows the installer\'s own version unless the environment says otherwise', () => {
  const nightlyPkg = { version: '0.17.0-nightly.1' };
  const stablePkg = { version: '0.17.0' };
  // Same rule the installer applies to its own package.json version.
  assert.equal(resolveChannel('', nightlyPkg.version), 'nightly', 'a nightly build installs nightlies');
  assert.equal(resolveChannel('', stablePkg.version), 'latest', 'a stable build never consumes a nightly');
  assert.equal(resolveChannel('latest', nightlyPkg.version), 'latest', 'the environment can pin a nightly installer to stable');
  assert.equal(resolveChannel('nightly', stablePkg.version), 'nightly', 'and can opt a stable installer into nightlies');
});

test('a packaged nightly installer installs the nightly Telegram connector and daemon', () => {
  // Build the artifact the way the nightly publish does: the same files, with the -nightly.N
  // version the bump script stamps into package.json before `npm publish --tag nightly`.
  const tmp = mkdtempSync(join(tmpdir(), 'installer-pkg-'));
  const stage = join(tmp, 'pkg');
  mkdirSync(stage, { recursive: true });
  cpSync(join(PKG, 'lib'), join(stage, 'lib'), { recursive: true });
  cpSync(INSTALL_MJS, join(stage, 'install.mjs'));
  const pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'));
  writeFileSync(join(stage, 'package.json'), JSON.stringify({ ...pkg, version: '0.17.0-nightly.1' }, null, 2));

  const bin = join(tmp, 'bin');
  mkdirSync(bin, { recursive: true });
  const log = join(tmp, 'calls.log');
  writeFileSync(log, '');
  fakeBins(bin, { daemon: 'absent' });
  const out = execFileSync('node', [join(stage, 'install.mjs')], {
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      CALLLOG: log,
      HOME: tmp,
      SHELL: '/bin/bash',
      OURS_ASSUME_YES: '1',
      NO_COLOR: '1',
      OURS_CONFIG: join(tmp, '.ours', 'config.json'),
    },
    encoding: 'utf8',
  });
  const calls = readFileSync(log, 'utf8');
  assert.match(calls, /npm i -g @ours\.network\/mcp@nightly/, 'the nightly installer installs the nightly daemon');
  assert.match(calls, /npm i -g @ours\.network\/codex@nightly/, 'and the nightly harness launcher');
  // fleet DOES publish a nightly dist-tag, and the nightly stack needs the fleet build
  // carrying the SDK integration — a nightly installer that quietly installed stable
  // fleet is the split-brain deployment the channel exists to prevent.
  assert.match(calls, /npm i -g @ours\.network\/fleet@nightly/, 'fleet follows the channel');
  assert.doesNotMatch(calls, /@ours\.network\/fleet@latest/, 'a nightly install never mixes in stable fleet');
  assert.doesNotMatch(calls, /@ours\.network\/mcp@latest/, 'no stable/nightly mixing within the suite');
  assert.ok(out.length > 0, 'the packaged installer runs from its own files');
  rmSync(tmp, { recursive: true, force: true });
});

// --- packaging: publishable standalone @ours.network/install (bin ships + zero external deps) ---
test('package is a publishable standalone: name @ours.network/install, bin + files, no runtime deps', () => {
  const pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'));
  assert.equal(pkg.name, '@ours.network/install', 'renamed to the publishable command package');
  assert.notEqual(pkg.private, true, 'must be publishable (private:false)');
  assert.equal(pkg.bin['ours-install'], 'install.mjs', 'ships the ours-install bin');
  for (const f of ['install.mjs', 'install.sh', 'lib', 'uninstall.mjs', 'uninstall.sh', 'README.md', 'LICENSE']) {
    assert.ok(pkg.files.includes(f), `files whitelist ships ${f}`);
  }
  // License: FSL, same identifier as the sibling @ours.network/* packages, with the LICENSE shipped.
  assert.equal(pkg.license, 'FSL-1.1-Apache-2.0', 'license matches the sibling packages');
  assert.ok(existsSync(join(PKG, 'LICENSE')), 'a LICENSE file is present to ship');
  // Self-contained: the installer + its lib import ONLY node built-ins (no @ours.network/* etc.).
  assert.ok(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0, 'no runtime dependencies');
  for (const f of ['install.mjs', 'lib/ui.mjs', 'lib/logic.mjs', 'lib/prompt.mjs', 'lib/config.mjs']) {
    const src = readFileSync(join(PKG, f), 'utf8');
    const imports = [...src.matchAll(/^import[^']*'([^']+)'/gm)].map((m) => m[1]);
    for (const spec of imports) {
      const builtin = spec.startsWith('node:') || spec.startsWith('./') || spec.startsWith('../');
      assert.ok(builtin, `${f} imports only built-ins / local — got "${spec}"`);
    }
  }
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
