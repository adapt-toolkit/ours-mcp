import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cli = new URL('../dist/cli.js', import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), 'ours-voice-setup-'));
const secret = 'pty-placeholder-secret-voice-setup';
const noSttyBin = join(dir, 'no-stty-bin');
mkdirSync(noSttyBin);
symlinkSync(process.execPath, join(noSttyBin, 'node'));

const DRIVER = String.raw`
import json, os, pty, select, signal, sys, termios, time
cli, config, mode, secret, node, no_stty_bin = sys.argv[1:7]
env = dict(os.environ)
for key in list(env):
    if key.startswith("OURS_STT_") or key in ("OURS_ASSUME_YES", "OURS_API_TOKEN"):
        env.pop(key, None)
env["OURS_CONFIG"] = config
env["OURS_PORT"] = "43991"
env["OURS_STATE_DIR"] = os.path.join(os.path.dirname(config), "state")
env["NO_COLOR"] = "1"
if mode == "fallback":
    env["PATH"] = no_stty_bin
pid, fd = pty.fork()
if pid == 0:
    os.execve(node, [node, cli, "voice-setup"], env)
    os._exit(127)
before = termios.tcgetattr(fd)
buf = b""
sent = set()
status = None
deadline = time.time() + 25
while time.time() < deadline:
    try:
        waited, child_status = os.waitpid(pid, os.WNOHANG)
    except ChildProcessError:
        break
    if waited:
        status = child_status
        break
    ready, _, _ = select.select([fd], [], [], 0.15)
    if ready:
        try:
            data = os.read(fd, 4096)
        except OSError:
            data = b""
        buf += data
    tail = buf[-3000:]
    if b"or j/k, then Enter" in tail and "provider" not in sent:
        os.write(fd, b"\x1b[B\x1b[B\r")
        sent.add("provider")
    elif b"Select 1-4:" in tail and "provider" not in sent:
        os.write(fd, b"3\n")
        sent.add("provider")
    elif b"Model (optional; Enter for provider default)" in tail and "model" not in sent:
        os.write(fd, b"\r" if mode != "fallback" else b"\n")
        sent.add("model")
    elif b"Custom base URL (optional)" in tail and "base" not in sent:
        os.write(fd, b"\r" if mode != "fallback" else b"\n")
        sent.add("base")
    elif b"Provider API key (input hidden)" in tail and "secret" not in sent:
        if mode == "cancel":
            os.write(fd, b"\x03")
        elif mode == "eof":
            os.write(fd, b"\x04")
        else:
            os.write(fd, secret.encode() + b"\r")
        sent.add("secret")
    elif b"Type SHOW to enter the token visibly" in tail and "fallback" not in sent:
        os.write(fd, b"\n")
        sent.add("fallback")
if status is None:
    os.kill(pid, signal.SIGKILL)
    os.waitpid(pid, 0)
    print(buf.replace(secret.encode(), b"[redacted]").decode(errors="replace"))
    print("HUNG")
    sys.exit(124)
after = termios.tcgetattr(fd)
text = buf.decode(errors="replace")
exit_code = os.waitstatus_to_exitcode(status)
print(json.dumps({
    "exit": exit_code,
    "secret_hidden": secret not in text,
    "terminal_restored": before == after,
    "ready": "voice transcription configured (deepgram)" in text,
    "cancelled": "cancelled" in text,
    "eof": "ended at EOF" in text,
    "fallback_warning": "Visible fallback will echo the token" in text,
}))
`;

function drive(name, mode) {
  const config = join(dir, `${name}.json`);
  const raw = execFileSync('python3', [
    '-c', DRIVER, cli, config, mode, secret, process.execPath, noSttyBin,
  ], {
    encoding: 'utf8',
    timeout: 30_000,
  }).trim();
  assert.doesNotMatch(raw, /HUNG/);
  return { config, result: JSON.parse(raw) };
}

try {
  const help = execFileSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.match(help, /voice-setup \[--dry-run\]/);
  const commandHelp = execFileSync(process.execPath, [cli, 'voice-setup', '--help'], { encoding: 'utf8' });
  assert.match(commandHelp, /key is never accepted as a CLI\s+argument/i);
  assert.match(commandHelp, /atomically with mode 0600/i);

  const headlessConfig = join(dir, 'headless.json');
  const headlessSecret = 'headless-placeholder-secret-voice';
  const headless = spawnSync(process.execPath, [cli, 'voice-setup'], {
    env: {
      ...process.env,
      OURS_CONFIG: headlessConfig,
      OURS_ASSUME_YES: '1',
      OURS_STT_PROVIDER: 'deepgram',
      OURS_STT_API_KEY: headlessSecret,
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(headless.status, 0);
  assert.match(headless.stdout, /already ready \(deepgram; API key from environment\)/);
  assert.doesNotMatch(`${headless.stdout}${headless.stderr}`, new RegExp(headlessSecret));
  assert.equal(existsSync(headlessConfig), false, 'environment-only headless setup does not persist the key');

  const argvSecret = 'argv-placeholder-secret-must-not-print';
  const rejectedArgv = spawnSync(
    process.execPath,
    [cli, 'voice-setup', argvSecret],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  assert.equal(rejectedArgv.status, 1);
  assert.match(`${rejectedArgv.stdout}${rejectedArgv.stderr}`, /key is never accepted as a CLI argument/i);
  assert.doesNotMatch(`${rejectedArgv.stdout}${rejectedArgv.stderr}`, new RegExp(argvSecret));

  const happy = drive('happy', 'happy');
  assert.deepEqual(happy.result, {
    exit: 0,
    secret_hidden: true,
    terminal_restored: true,
    ready: true,
    cancelled: false,
    eof: false,
    fallback_warning: false,
  });
  const config = JSON.parse(readFileSync(happy.config, 'utf8'));
  assert.equal(config.stt.provider, 'deepgram');
  assert.equal(config.stt.apiKey, secret);
  assert.equal(statSync(happy.config).mode & 0o777, 0o600);

  const cancelled = drive('cancelled', 'cancel');
  assert.equal(cancelled.result.exit, 130);
  assert.equal(cancelled.result.terminal_restored, true);
  assert.equal(cancelled.result.cancelled, true);
  assert.equal(existsSync(cancelled.config), false);

  const eof = drive('eof', 'eof');
  assert.equal(eof.result.exit, 1);
  assert.equal(eof.result.terminal_restored, true);
  assert.equal(eof.result.eof, true);
  assert.equal(existsSync(eof.config), false);

  const fallback = drive('fallback', 'fallback');
  assert.equal(fallback.result.exit, 130);
  assert.equal(fallback.result.fallback_warning, true);
  assert.equal(existsSync(fallback.config), false);

  console.log('voice-setup CLI/PTY/headless: 29 passed');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
