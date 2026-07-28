// Integration tests for the unified `ours-install` (v2 flow). No network: fake `npm`, `ours-mcp`,
// `claude`, `codex`, `ours-fleet`, and `ours-tg-connector` are put on PATH; each logs its argv to
// $CALLLOG. We then assert the installer drives them in the right order with the right args,
// non-interactively (OURS_ASSUME_YES=1). HOME is redirected to a temp dir so config writes and the
// interactive-shell `type` probe never touch the real user environment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync, mkdirSync, statSync, symlinkSync } from 'node:fs';
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
//   opts.rootExists  : name → `ours-mcp create-root` reports it already exists (quiet no-op)
//   opts.hermesPresent : create <HOME>/.hermes so Hermes is detected (config-dir based, handled in runInstall)
function fakeBins(dir, opts = {}) {
  const daemonInstalled = opts.daemon !== 'absent';
  const port = opts.daemonPort || 3050;
  const write = (n, body) => { const p = join(dir, n); writeFileSync(p, `#!/bin/bash\nprintf '%s %s\\n' "${n}" "$*" >> "$CALLLOG"\n${body}`); chmodSync(p, 0o755); };

  // ours-mcp: --version answers when "installed"; status reports running + a url line for the port;
  // create-root is a quiet no-op that echoes the existing name when opts.rootExists is set.
  const mcpVersion = daemonInstalled
    ? `[ "$1" = "--version" ] && { echo "ours-mcp v9.9.9"; exit 0; }\n`
    : `[ "$1" = "--version" ] && { [ -f "$CALLLOG.mcpinstalled" ] && { echo "ours-mcp v9.9.9"; exit 0; } || exit 1; }\n`;
  const createRoot = opts.rootExists
    ? `[ "$1" = "create-root" ] && { echo 'create-root: a root identity already exists ("${opts.rootExists}") — nothing to do.'; exit 0; }\n`
    : `[ "$1" = "create-root" ] && { echo "created root identity"; exit 0; }\n`;
  write('ours-mcp',
    mcpVersion +
    `[ "$1" = "status" ] && { echo "ours-mcp: running"; echo "  url:    http://localhost:${port}/mcp (reachable)"; exit 0; }\n` +
    createRoot +
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
  // Hermes plugin front-door: logs its argv (so we can assert --skip-daemon) and succeeds.
  write('ours-hermes-install', `exit 0\n`);
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
  // Config-first questions are SKIPPED when a daemon already exists.
  assert.doesNotMatch(out, /A couple of quick settings/, 'no Step 0 on an already-configured daemon');
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
  assert.match(out, /A couple of quick settings/, 'Step 0 config questions run on a first install');
  assert.match(out, /1\/4 — ours core/, 'daemon is step 1');
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
  assert.match(out, /Run ours-install in a terminal/);
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
function ptyBins() {
  const tmp = mkdtempSync(join(tmpdir(), 'installer-'));
  const bin = join(tmp, 'bin');
  mkdirSync(bin, { recursive: true });
  const log = join(tmp, 'calls.log');
  writeFileSync(log, '');
  fakeBins(bin, { daemon: 'installed' });
  return { tmp, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALLLOG: log, HOME: tmp, SHELL: '/bin/bash' } };
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

// Drive a FIRST install through the actual masked voice-key prompt. This proves the key is accepted
// but never echoed into terminal output (the unit tests separately cover validation/storage).
const PTY_VOICE_MASKED = `
import os, pty, sys, time, select
secret=b"pty-placeholder-secret-123"
env=dict(os.environ); env["OURS_INSTALL_DRY_RUN"]="1"; env["NO_COLOR"]="1"; env.pop("OURS_ASSUME_YES",None)
pid,fd=pty.fork()
if pid==0: os.execvpe("node",["node",sys.argv[1]],env); os._exit(127)
buf=b""; pending=b""; last=time.time(); st=None
def answer():
    global pending
    if not pending.endswith((b"] ", b": ")): return
    tail=pending[-500:]
    if b"Provider (openai-compatible" in tail: reply=b"deepgram\\n"
    elif b"Provider API key" in tail: reply=secret+b"\\n"
    else: reply=b"\\n"
    os.write(fd,reply); pending=b""
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
print("VOICE_OK" if "Voice transcription would be configured (deepgram)" in text else "VOICE_MISSING")
print("SECRET_LEAK" if secret.decode() in text else "SECRET_HIDDEN")
`;
test('fresh interactive install accepts a masked voice key without terminal/log disclosure',
  { skip: hasPython3() ? false : 'python3 not available for pty' }, () => {
  const { tmp, env } = ptyBins();
  // Make the fake daemon initially absent so this is the fresh-install path.
  fakeBins(join(tmp, 'bin'), { daemon: 'absent' });
  const out = execFileSync('python3', ['-c', PTY_VOICE_MASKED, INSTALL_MJS], {
    encoding: 'utf8', timeout: 120_000, env,
  });
  assert.match(out, /EXIT 0/);
  assert.match(out, /VOICE_OK/);
  assert.match(out, /SECRET_HIDDEN/);
  assert.doesNotMatch(out, /SECRET_LEAK/);
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
