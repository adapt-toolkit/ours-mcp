// Integration tests for `ours-install` v3 — the REAL bin, end to end.
//
// The orchestrator tests drive lib/ with a fake effects object. This file drives
// `node install.mjs` as a user would, with fake `npm`, `ours`, `ours-mcp`,
// `claude`, `codex`, `ours-fleet`, `ours-tg-connector` and `ours-hermes-install`
// on PATH, each logging its argv (and the daemon environment it received) to
// $CALLLOG. HOME is a temp directory, so config writes and the interactive-shell
// `type` probe never touch the real user environment.
//
// TWO HOST RULES, because this suite runs on a machine hosting a live fleet:
//
//   NO SERVICE IS EVER INSTALLED, ENABLED OR STARTED, and `systemctl` is never
//   reached — asserted below over the whole call log, not assumed. `ours` is a
//   shell script that logs and exits 0.
//
//   NO REAL DAEMON IS CONTACTED. Every run names its own state directory AND its
//   own port, and that port is one this process just proved free — so the
//   installer's identity probe talks to nothing, or to a stub HTTP server this
//   file started on an ephemeral port and closes again. Port 3050 (and the
//   reserved 3051/3052) are never probed, because a run that fell back to the
//   default port would be probing whatever the host is really running.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createSocketServer } from 'node:net';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync, mkdirSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = dirname(HERE);
const INSTALL_MJS = join(PKG, 'install.mjs');
const INSTALL_SH = join(PKG, 'install.sh');

/** A port the OS just handed out and nothing is listening on. Never 3050-3052. */
function freePort() {
  return new Promise((resolve) => {
    const s = createSocketServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      assert.ok(port > 3052, 'the OS handed out an ephemeral port, never a reserved one');
      s.close(() => resolve(port));
    });
  });
}

/**
 * The smallest thing that looks like an ours daemon to the installer: one
 * unauthenticated GET /state-dir. This is what makes the UPDATE path testable
 * without starting anything that could outlive the test.
 */
function stubDaemon(stateDir) {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ stateDir }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        // closeAllConnections FIRST: the installer probes with fetch, which
        // keeps its socket alive, and a bare close() would then wait for a
        // connection nobody is going to end — a hung test suite, not a failing
        // one, which is the harder kind to diagnose.
        close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(done); }),
      });
    });
  });
}

/**
 * Run the bin WITHOUT blocking this process's event loop.
 *
 * execFileSync would be shorter and wrong: the stub daemon below lives in THIS
 * process, so a synchronous child means the stub can never accept the
 * installer's probe, every update-path run silently takes the create path, and
 * the suite tests a flow that no user will ever hit.
 */
function runBin(args, env) {
  return new Promise((resolve) => {
    const child = spawn('node', [INSTALL_MJS, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ out, code: code ?? 1 }));
  });
}

// Fakes that append "<name> <args>" to $CALLLOG — plus, for the commands that
// must receive the daemon pair, the OURS_CONFIG they actually got.
//   opts.codex         : 'ok' (default) | 'unsafe' (--version returns junk, non-zero)
//   opts.noHarness     : omit claude+codex entirely
//   opts.rootExists    : name → `ours-mcp create-root` reports it already exists
//   opts.hermesPresent : create <HOME>/.hermes so Hermes is detected
//   opts.voiceReady    : `ours-mcp voice-status --json` reports a configured provider
function fakeBins(dir, opts = {}) {
  const write = (n, body) => {
    const p = join(dir, n);
    writeFileSync(p, `#!/bin/bash\nprintf '%s %s\\n' "${n}" "$*" >> "$CALLLOG"\n${body}`);
    chmodSync(p, 0o755);
  };
  const logEnv = (n) => `printf '%s env OURS_CONFIG=%s\\n' "${n}" "$OURS_CONFIG" >> "$CALLLOG"\n`;

  // The v3 daemon: the ours-sdk CLI. install-service answers with its --json
  // plan, exactly as the real one does, and NEVER touches systemd here.
  write('ours',
    `[ "$1" = "daemon" ] && [ "$2" = "install-service" ] && { echo '{"changed":true,"unitName":"ours.service"}'; exit 0; }\n`
    + 'exit 0\n');

  const createRoot = opts.rootExists
    ? `[ "$1" = "create-root" ] && { echo 'create-root: a root identity already exists ("${opts.rootExists}") — nothing to do.'; exit 0; }\n`
    : `[ "$1" = "create-root" ] && { echo "created root identity"; exit 0; }\n`;
  write('ours-mcp',
    logEnv('ours-mcp')
    + '[ "$1" = "--version" ] && { echo "ours-mcp v9.9.9"; exit 0; }\n'
    + `[ "$1" = "voice-status" ] && { ${opts.voiceReady
      ? `echo '{"ready":true,"provider":"deepgram"}'; exit 0;`
      : `echo '{"ready":false}'; exit 0;`} }\n`
    + '[ "$1" = "voice-setup" ] && { echo "canonical ours-mcp voice-setup"; exit 0; }\n'
    + createRoot
    + 'exit 0\n');

  write('npm', 'case "$1" in ls) echo \'{"dependencies":{}}\';; esac\nexit 0\n');
  if (!opts.noHarness) {
    write('claude', '[ "$1" = "--version" ] && { echo "2.1.181 (Claude Code)"; exit 0; }\nexit 0\n');
    write('codex', opts.codex === 'unsafe'
      ? '[ "$1" = "--version" ] && { echo "not-a-version-string"; exit 1; }\nexit 0\n'
      : '[ "$1" = "--version" ] && { echo "codex-cli 0.144.4"; exit 0; }\nexit 0\n');
  }
  write('ours-fleet', '[ "$1" = "--version" ] && { echo "0.7.0"; exit 0; }\nexit 0\n');
  write('ours-tg-connector', 'exit 0\n');
  write('ours-hermes-install', logEnv('ours-hermes-install') + 'exit 0\n');
}

/**
 * Run the real bin. Every run names BOTH its state directory and its port, and
 * seeds that port into the config so the installer's first probe goes to a port
 * this test owns rather than to the host's default one.
 */
async function runInstall(opts = {}, extraEnv = {}, argv = null) {
  const tmp = mkdtempSync(join(tmpdir(), 'installer-v3-'));
  const bin = join(tmp, 'bin');
  mkdirSync(bin, { recursive: true });
  const log = join(tmp, 'calls.log');
  writeFileSync(log, '');
  fakeBins(bin, opts);
  if (opts.hermesPresent) mkdirSync(join(tmp, '.hermes'), { recursive: true });

  const stateDir = opts.stateDir ? join(tmp, opts.stateDir) : join(tmp, '.ours');
  const port = opts.port ?? await freePort();
  if (opts.seedConfig !== false) {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'config.json'), `${JSON.stringify({ port, ...(opts.config ?? {}) }, null, 2)}\n`, { mode: 0o600 });
  }

  let path = `${bin}:${process.env.PATH}`;
  if (opts.noHarness) {
    // A restricted PATH so the host's real claude/codex cannot leak in.
    try { symlinkSync(process.execPath, join(bin, 'node')); } catch { /* already there */ }
    for (const b of ['bash', 'env', 'cat', 'printf']) {
      const p = [`/bin/${b}`, `/usr/bin/${b}`].find((x) => existsSync(x));
      if (p) { try { symlinkSync(p, join(bin, b)); } catch { /* ignore */ } }
    }
    path = `${bin}:/usr/bin:/bin`;
  }
  const env = {
    PATH: path,
    CALLLOG: log,
    HOME: tmp,
    SHELL: '/bin/bash',
    OURS_ASSUME_YES: '1',
    NO_COLOR: '1',
    ...extraEnv,
  };
  const args = argv ?? ['--state-dir', stateDir, '--port', String(port)];
  const { out, code } = await runBin(args, env);
  return { out, code, calls: readFileSync(log, 'utf8'), tmp, stateDir, port };
}

// The rule that outranks every feature in this package.
function assertNeverTouchedSystemd(calls) {
  assert.doesNotMatch(calls, /systemctl/, 'systemctl is never run');
  assert.doesNotMatch(calls, /loginctl/, 'loginctl is never run');
}

// ------------------------------------------------------------ first install --

test('first install: CLI, config, daemon start, boot service — in that order', async () => {
  const { out, calls, code, tmp, stateDir, port } = await runInstall({ seedConfig: false });
  assert.equal(code, 0);
  assertNeverTouchedSystemd(calls);
  assert.match(calls, /npm i -g @ours\.network\/cli/, 'the v3 daemon is the ours-sdk CLI, not ours-mcp');
  assert.match(calls, /ours daemon start --config /, 'the daemon is started by the CLI');
  assert.match(calls, /ours daemon install-service .*--state-dir /, 'the unit is keyed to the STATE DIRECTORY');
  assert.ok(calls.indexOf('ours daemon start') < calls.indexOf('install-service'),
    'started before its boot service is installed');
  // The config the run wrote, with the port it was given and nothing invented.
  const parsed = JSON.parse(readFileSync(join(stateDir, 'config.json'), 'utf8'));
  assert.equal(parsed.port, port);
  assert.equal(parsed.stateDir, stateDir);
  assert.equal(statSync(join(stateDir, 'config.json')).mode & 0o777, 0o600);
  assert.match(out, /install complete/);
  rmSync(tmp, { recursive: true, force: true });
});

test('the MCP server is a component, and it is what the later phases invoke', async () => {
  const { out, calls, tmp, stateDir } = await runInstall({ seedConfig: false });
  assert.match(calls, /npm i -g @ours\.network\/mcp/, 'the MCP server is installed as a component');
  assert.doesNotMatch(calls, /ours-mcp install-service/, 'and gets NO unit: it is a per-session stdio proxy');
  assert.match(calls, /ours-mcp create-root /, 'the human identity is created in-install');
  assert.ok(calls.indexOf('@ours.network/mcp') < calls.indexOf('create-root'),
    'installed before anything shells out to it');
  // The pair travelled: create-root reached THIS daemon, not the default one.
  assert.match(calls, new RegExp(`ours-mcp env OURS_CONFIG=${join(stateDir, 'config.json')}`));
  assert.match(out, /Your human identity/, 'user-facing copy says "human identity"');
  rmSync(tmp, { recursive: true, force: true });
});

test('an identity that already exists is kept, with its name, and is never a failure', async () => {
  const { out, calls, tmp } = await runInstall({ seedConfig: false, rootExists: 'Vitalii' });
  assert.match(calls, /ours-mcp create-root /);
  assert.match(out, /already have a human identity \("Vitalii"\)/);
  assert.match(out, /keeping it/);
  assert.doesNotMatch(out, /needs attention.*[Hh]uman identity/);
  rmSync(tmp, { recursive: true, force: true });
});

// ------------------------------------------------------------------ update --

/** A temp home with fakes on PATH, ready for a run against a stub daemon. */
function stubHost() {
  const tmp = mkdtempSync(join(tmpdir(), 'installer-v3-'));
  const bin = join(tmp, 'bin');
  mkdirSync(bin, { recursive: true });
  const log = join(tmp, 'calls.log');
  writeFileSync(log, '');
  fakeBins(bin, {});
  const stateDir = join(tmp, '.ours');
  mkdirSync(stateDir, { recursive: true });
  return {
    tmp,
    log,
    stateDir,
    calls: () => readFileSync(log, 'utf8'),
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      CALLLOG: log,
      HOME: tmp,
      SHELL: '/bin/bash',
      OURS_ASSUME_YES: '1',
      NO_COLOR: '1',
    },
  };
}

test('update: a daemon that owns THIS state directory is adopted, never recreated', async () => {
  const host = stubHost();
  const daemon = await stubDaemon(host.stateDir);
  try {
    const config = join(host.stateDir, 'config.json');
    writeFileSync(config, `${JSON.stringify({ port: daemon.port, stateDir: host.stateDir, brokerUrl: 'wss://broker1.ours.network' }, null, 2)}\n`, { mode: 0o600 });
    const before = readFileSync(config, 'utf8');
    const { out, code } = await runBin(['--state-dir', host.stateDir], host.env);
    assert.equal(code, 0);
    assert.match(out, new RegExp(`daemon found on port ${daemon.port}`), 'found by the directory\'s own record');
    assert.doesNotMatch(host.calls(), /ours daemon start/, 'a running daemon is never started again');
    assert.equal(readFileSync(config, 'utf8'), before, 'a config that already matches is not rewritten');
    assert.match(out, /already correct — not touched/);
    assertNeverTouchedSystemd(host.calls());
  } finally {
    await daemon.close();
    rmSync(host.tmp, { recursive: true, force: true });
  }
});

test('a daemon owning ANOTHER state directory is refused, and nothing is installed', async () => {
  const host = stubHost();
  const elsewhere = mkdtempSync(join(tmpdir(), 'installer-other-'));
  const daemon = await stubDaemon(elsewhere);
  try {
    writeFileSync(join(host.stateDir, 'config.json'), `${JSON.stringify({ port: daemon.port }, null, 2)}\n`, { mode: 0o600 });
    const { out, code } = await runBin(['--state-dir', host.stateDir], host.env);
    assert.equal(code, 2, 'a daemon owning another state directory is a refusal, not an adoption');
    assert.match(out, /owns state directory/);
    assert.equal(host.calls(), '', 'not one command ran');
    assertNeverTouchedSystemd(host.calls());
  } finally {
    await daemon.close();
    rmSync(host.tmp, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test('a --port that disagrees with the running daemon exits 2 and writes nothing', async () => {
  const host = stubHost();
  const daemon = await stubDaemon(host.stateDir);
  try {
    writeFileSync(join(host.stateDir, 'config.json'), `${JSON.stringify({ port: daemon.port }, null, 2)}\n`, { mode: 0o600 });
    const { out, code } = await runBin(['--state-dir', host.stateDir, '--port', String(daemon.port + 1)], host.env);
    assert.equal(code, 2);
    assert.match(out, /disagrees with port/);
    assert.match(out, /Nothing was written/);
    assert.equal(host.calls(), '', 'not one command ran');
  } finally {
    await daemon.close();
    rmSync(host.tmp, { recursive: true, force: true });
  }
});

test('a daemon found ONLY by its PID record is still an update, not a second daemon', async () => {
  // The corruption guard, end to end and through the real bin: a daemon started
  // by hand records nothing in config.json, and creating a second writer on one
  // state_data.bin is the failure this lookup exists to prevent.
  const host = stubHost();
  const daemon = await stubDaemon(host.stateDir);
  try {
    writeFileSync(join(host.stateDir, 'ours-cli-daemon.json'), `${JSON.stringify({ port: daemon.port })}\n`, { mode: 0o600 });
    const { out, code } = await runBin(['--state-dir', host.stateDir], host.env);
    assert.equal(code, 0);
    assert.match(out, new RegExp(`daemon found on port ${daemon.port}`));
    assert.doesNotMatch(host.calls(), /ours daemon start/, 'a second daemon must not be created here');
  } finally {
    await daemon.close();
    rmSync(host.tmp, { recursive: true, force: true });
  }
});

// -------------------------------------------------------- the four extras ---

test('harness plugins: Claude and Codex are driven, and the flow continues past a failure', async () => {
  const { out, calls, tmp } = await runInstall({ seedConfig: false });
  assert.match(calls, /claude plugin marketplace add adapt-toolkit\/ours-claude-marketplace/);
  assert.match(calls, /claude plugin install ours@ours\.network/);
  assert.match(calls, /codex plugin marketplace add adapt-toolkit\/ours-codex-marketplace/);
  assert.match(calls, /codex plugin add ours@ours-codex-marketplace/);
  assert.match(calls, /npm i -g @ours\.network\/codex@latest/, 'the ours-codex launcher rides along, as the owner mandated');
  assert.match(out, /install complete/);
  rmSync(tmp, { recursive: true, force: true });
});

test('never dead-end: an undrivable codex is not called, and its manual path is printed', async () => {
  const { out, calls, tmp } = await runInstall({ seedConfig: false, codex: 'unsafe' });
  assert.doesNotMatch(calls, /codex plugin/, 'an unsafe codex is never driven');
  assert.match(out, /codex plugin marketplace add adapt-toolkit\/ours-codex-marketplace/, 'manual path shown');
  assert.match(out, /npm i -g @ours\.network\/codex/);
  assert.match(calls, /claude plugin install ours@ours\.network/, 'the good harness still installs');
  assert.match(calls, /ours-fleet init/, 'and the run reaches the later phases');
  rmSync(tmp, { recursive: true, force: true });
});

test('Hermes: npm + ours-hermes-install --skip-daemon, and the pair reaches the writer', async () => {
  const { out, calls, tmp, stateDir } = await runInstall({ seedConfig: false, stateDir: '.ours-tg', hermesPresent: true });
  assert.match(calls, /npm i -g @ours\.network\/hermes@latest/);
  assert.match(calls, /ours-hermes-install --skip-daemon/, 'the installer already owns the daemon');
  // The one harness whose registration CAN carry the pair, so it does.
  assert.match(calls, new RegExp(`ours-hermes-install env OURS_CONFIG=${join(stateDir, 'config.json')}`));
  assert.doesNotMatch(out, /Hermes.*cannot carry a value/);
  rmSync(tmp, { recursive: true, force: true });
});

test('a non-default state directory tells the truth about Claude and Codex', async () => {
  const { out, calls, tmp, stateDir } = await runInstall({ seedConfig: false, stateDir: '.ours-tg' });
  // Their registrations cannot carry a value, so the run says so and gives the
  // exact line instead of claiming spec §5's guarantee.
  assert.match(out, /cannot carry a value/);
  assert.match(out, new RegExp(`export OURS_CONFIG=${join(stateDir, 'config.json')}`));
  assert.doesNotMatch(calls, new RegExp(`claude env OURS_CONFIG=${join(stateDir, 'config.json')}`));
  rmSync(tmp, { recursive: true, force: true });
});

test('ours-fleet is installed and initialised, and the installer configures nothing in it', async () => {
  const { out, calls, tmp, stateDir } = await runInstall({ seedConfig: false, stateDir: '.ours-tg' });
  assert.match(calls, /npm i -g @ours\.network\/fleet@latest/, 'fleet is pinned to @latest: it has no nightly tag');
  assert.match(calls, /ours-fleet init/);
  assert.ok(!existsSync(join(tmp, '.ours-fleet', 'fleet.yaml')), 'the installer writes no fleet config');
  assert.match(out, new RegExp(`env: \\{ OURS_CONFIG: ${join(stateDir, 'config.json')} \\}`),
    'it SAYS the one fleet.yaml line, which is the whole feature');
  rmSync(tmp, { recursive: true, force: true });
});

test('voice: a non-interactive run leaves it alone and says how to configure it', async () => {
  const { out, calls, tmp } = await runInstall({ seedConfig: false });
  assert.match(out, /voice setup is interactive and this run is not/);
  assert.doesNotMatch(calls, /ours-mcp voice-setup/, 'the interactive command is never launched headlessly');
  assert.doesNotMatch(calls, /ours daemon restart/, 'and no daemon is bounced for a config nobody wrote');
  rmSync(tmp, { recursive: true, force: true });
});

test('voice: an already-configured daemon is reported and left entirely alone', async () => {
  const { out, calls, tmp } = await runInstall({ seedConfig: false, voiceReady: true });
  assert.match(out, /voice transcription is already configured/);
  assert.doesNotMatch(calls, /ours-mcp voice-setup/);
  assert.doesNotMatch(calls, /ours daemon restart/);
  rmSync(tmp, { recursive: true, force: true });
});

test('the hand-off is the last thing the run produces, and it drops what it already did', async () => {
  const { out, tmp } = await runInstall({ seedConfig: false });
  assert.match(out, /paste this into your agent/);
  assert.doesNotMatch(out, /Create my Ours human identity/, 'created in-install, so its step drops');
  assert.match(out, /Set up my ours-fleet/);
  assert.match(out, /PERMANENT use/);
  assert.doesNotMatch(out, /Set up my Telegram bot/, 'the connector is not installed by default');
  rmSync(tmp, { recursive: true, force: true });
});

test('a non-default state directory tells the agent which daemon to configure', async () => {
  const { out, tmp, stateDir } = await runInstall({ seedConfig: false, stateDir: '.ours-tg' });
  assert.match(out, /set OURS_CONFIG to that path/);
  assert.match(out, new RegExp(join(stateDir, 'config.json')));
  rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------- the bin ---

test('--help and --version are answered by the bin and change nothing', async () => {
  for (const flag of ['--help', '-h']) {
    const { out, code, calls, tmp } = await runInstall({ seedConfig: false }, {}, [flag]);
    assert.equal(code, 0, flag);
    assert.match(out, /--state-dir/, 'the help names the flag that identifies a daemon');
    assert.match(out, /--dry-run/);
    assert.equal(calls, '', `${flag} runs nothing`);
    rmSync(tmp, { recursive: true, force: true });
  }
  const { out, code, calls, tmp } = await runInstall({ seedConfig: false }, {}, ['--version']);
  assert.equal(code, 0);
  assert.match(out, /^ours-install v\d+\.\d+\.\d+/m);
  assert.equal(calls, '');
  rmSync(tmp, { recursive: true, force: true });
});

test('an unknown flag exits 2 without running a single command', async () => {
  const { out, code, calls, tmp } = await runInstall({ seedConfig: false }, {}, ['--nope']);
  assert.equal(code, 2);
  assert.match(out, /unknown option: --nope/);
  assert.equal(calls, '');
  rmSync(tmp, { recursive: true, force: true });
});

test('--dry-run walks the WHOLE flow and mutates nothing', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'installer-v3-'));
  const bin = join(tmp, 'bin');
  mkdirSync(bin, { recursive: true });
  const log = join(tmp, 'calls.log');
  writeFileSync(log, '');
  fakeBins(bin, { hermesPresent: true });
  mkdirSync(join(tmp, '.hermes'), { recursive: true });
  const stateDir = join(tmp, '.ours-dry');
  const port = await freePort();
  const out = execFileSync('node', [INSTALL_MJS, '--dry-run', '--state-dir', stateDir, '--port', String(port)], {
    env: { PATH: `${bin}:${process.env.PATH}`, CALLLOG: log, HOME: tmp, SHELL: '/bin/bash', OURS_ASSUME_YES: '1', NO_COLOR: '1' },
    encoding: 'utf8',
    stdio: 'pipe',
  });
  // A dry run is the same walk with every mutation replaced by a printed line —
  // which is exactly why it can be trusted on a machine you must not disturb.
  // Harness DETECTION still runs — a dry run has to know what it would install
  // — but every call in the log must be a read-only probe and nothing else.
  for (const call of readFileSync(log, 'utf8').split('\n').filter(Boolean)) {
    assert.match(call, /--version$/, `a dry run runs only read-only probes, got: ${call}`);
  }
  assert.equal(existsSync(stateDir), false, 'not one directory, let alone a config file');
  assert.match(out, /\[dry-run\] would: ours CLI installed/);
  assert.match(out, /\[dry-run\] would: start the daemon on port/);
  assert.match(out, /\[dry-run\] would: boot service .* installed and enabled/);
  assert.match(out, /\[dry-run\] would: install @ours\.network\/mcp/);
  assert.match(out, /\[dry-run\] would: ours-mcp create-root/);
  assert.match(out, /\[dry-run\] would: npm i -g @ours\.network\/fleet/);
  assert.match(out, /install complete/, 'and it still reaches the summary');
  rmSync(tmp, { recursive: true, force: true });
});

test('no harness at all: the daemon is still installed, and the run says what is missing', async () => {
  const { out, calls, tmp } = await runInstall({ seedConfig: false, noHarness: true });
  // A deliberate divergence from v2, which exited before installing anything.
  // Under v3 the daemon is the product; a harness plugin is one extra of several.
  assert.match(out, /No Claude Code, Codex or Hermes found/);
  assert.match(calls, /npm i -g @ours\.network\/cli/, 'the daemon is installed anyway');
  assert.doesNotMatch(calls, /plugin/, 'but no plugin work happens');
  rmSync(tmp, { recursive: true, force: true });
});

test('install.mjs is a BIN and nothing else: no decisions, no side effects of its own', async () => {
  const src = readFileSync(INSTALL_MJS, 'utf8');
  assert.ok(src.split('\n').length < 120, 'a bin that grows a body is how two flows end up in one file');
  assert.match(src, /runInstall/, 'it delegates the walk');
  assert.match(src, /realEffects/, 'and the side effects');
  // The v2 body is gone, not commented out or conditionally skipped.
  for (const ghost of ['offerVoiceSetup', 'installClaude', 'installCodex', 'endScreen(', 'buildHandoffPrompt(', 'spawnSync']) {
    assert.ok(!src.includes(ghost), `the v2 body must be gone, found: ${ghost}`);
  }
  assert.doesNotMatch(src, /askSecret|Provider \(openai-compatible/,
    'no duplicate credential prompt implementation');
});

// --- packaging: publishable standalone @ours.network/install ------------------------------------
test('package is a publishable standalone: name @ours.network/install, bin + files, no runtime deps', async () => {
  const pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'));
  assert.equal(pkg.name, '@ours.network/install');
  assert.notEqual(pkg.private, true, 'must be publishable (private:false)');
  assert.equal(pkg.bin['ours-install'], 'install.mjs', 'ships the ours-install bin');
  for (const f of ['install.mjs', 'install.sh', 'lib', 'uninstall.mjs', 'uninstall.sh', 'README.md', 'LICENSE']) {
    assert.ok(pkg.files.includes(f), `files whitelist ships ${f}`);
  }
  assert.equal(pkg.license, 'FSL-1.1-Apache-2.0');
  assert.ok(existsSync(join(PKG, 'LICENSE')));
  assert.ok(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0, 'no runtime dependencies');
  for (const f of ['install.mjs', 'lib/ui.mjs', 'lib/logic.mjs', 'lib/prompt.mjs', 'lib/config.mjs',
    'lib/effects.mjs', 'lib/orchestrate.mjs', 'lib/extras.mjs', 'lib/usage.mjs']) {
    const src = readFileSync(join(PKG, f), 'utf8');
    for (const [, spec] of src.matchAll(/^import[^']*'([^']+)'/gm)) {
      assert.ok(spec.startsWith('node:') || spec.startsWith('./') || spec.startsWith('../'),
        `${f} imports only built-ins / local — got "${spec}"`);
    }
  }
});

// --- install.sh bootstrap: Node.js check (unchanged contract) ----------------------------------
test('install.sh with no Node.js prints friendly per-OS guidance and exits 0', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'installer-v3-'));
  const bin = join(tmp, 'bin');
  mkdirSync(bin, { recursive: true });
  let hasNode = true;
  try { execFileSync('bash', ['-c', 'command -v node'], { env: { PATH: '/usr/bin:/bin' }, stdio: 'ignore' }); }
  catch { hasNode = false; }
  if (hasNode) {
    // A system node leaks into the restricted PATH, so install.sh would hand off
    // to the real installer rather than print the guidance this test is about.
    // Asserting on that hand-off would be asserting on the host, not the script.
    rmSync(tmp, { recursive: true, force: true });
    return;
  }
  const out = execFileSync('bash', [INSTALL_SH], {
    env: { PATH: `/usr/bin:/bin:${bin}`, HOME: tmp },
    stdio: 'pipe',
    encoding: 'utf8',
  }).toString();
  assert.match(out, /Node\.js/, 'explains Node.js is needed');
  assert.match(out, /nodejs\.org/, 'links nodejs.org');
  assert.doesNotMatch(out, /install\.mjs/, 'must not try to run the Node installer without node');
  rmSync(tmp, { recursive: true, force: true });
});
