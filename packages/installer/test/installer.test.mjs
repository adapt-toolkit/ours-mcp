// Integration test for the unified installer. No network: fake `npm`, `ours-mcp`, and the
// per-harness `ours-<h>-install` bins are put on PATH; each logs its argv to a file. We then
// assert the installer drives them in the right order with the right args, non-interactively.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const INSTALL = join(dirname(HERE), 'install.sh');

// Build a temp bin dir of fakes that append "<name> <args>" to $CALLLOG.
// The fake `ours-mcp` answers `--version` — its presence means "daemon already installed" — unless
// opts.notInstalled, which makes every probe fail silently (like a missing binary) until the fake
// `npm` "installs" @ours.network/mcp (marker file), so the consent gate sees a first-time install
// that then really completes. It must still shadow any REAL ours-mcp on the host's PATH.
function fakeBins(dir, names, opts = {}) {
  for (const n of names) {
    let special = '';
    if (n === 'ours-mcp') {
      const installedBehaviour =
        `[ "$1" = "--version" ] && { echo "ours-mcp v9.9.9"; exit 0; }\n` +
        // `ours-mcp status` should fail (so the installer starts it) unless told otherwise
        `[ "$1" = "status" ] && exit ${opts.daemonRunning ? 0 : 1}\n`;
      special = opts.notInstalled
        ? `[ -f "$CALLLOG.mcpinstalled" ] || exit 1\n` + installedBehaviour
        : installedBehaviour;
    } else if (n === 'npm') {
      special = `case "$*" in *"@ours.network/mcp"*) touch "$CALLLOG.mcpinstalled";; esac\n`;
    }
    const body =
      `#!/bin/bash\n` +
      `printf '%s %s\\n' "${n}" "$*" >> "$CALLLOG"\n` +
      special +
      `exit 0\n`;
    const p = join(dir, n);
    writeFileSync(p, body);
    chmodSync(p, 0o755);
  }
}

test('installs daemon + selected npm harnesses (identity-free base install), skips service', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'installer-'));
  const bin = join(tmp, 'bin');
  execFileSync('mkdir', ['-p', bin]);
  const log = join(tmp, 'calls.log');
  writeFileSync(log, '');
  // ours-mcp absent at first? We include it so `command -v` finds it; status returns non-zero
  // → installer calls `ours-mcp start`.
  fakeBins(bin, ['npm', 'ours-mcp', 'ours-hermes-install', 'ours-codex-install']);

  execFileSync('bash', [INSTALL], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      CALLLOG: log,
      OURS_ASSUME_YES: '1',
      OURS_SERVICE: 'no',
      OURS_HARNESSES: 'codex hermes',
      // Even if a stale OURS_IDENTITIES is present, the base installer must ignore it entirely —
      // wake is set up in-session now, never by the installer.
      OURS_IDENTITIES: 'Alice Bob',
    },
    stdio: 'pipe',
  });

  const calls = readFileSync(log, 'utf8');
  // daemon started (status failed → start)
  assert.match(calls, /ours-mcp start/, 'daemon should be started');
  // no persistent service (OURS_SERVICE=no)
  assert.doesNotMatch(calls, /install-service/, 'service must be skipped');
  // selected harnesses installed + configured
  assert.match(calls, /npm i -g @ours\.network\/codex/, 'codex package installed');
  assert.match(calls, /ours-codex-install/, 'codex installer run');
  assert.match(calls, /npm i -g @ours\.network\/hermes/, 'hermes package installed');
  assert.match(calls, /ours-hermes-install/, 'hermes installer run');
  // the installer must NEVER forward identities / wake flags — that concept is gone from install
  assert.doesNotMatch(calls, /--identities/, 'installer must not forward --identities');
  assert.doesNotMatch(calls, /Alice|Bob/, 'installer must not pass any identity names through');
  // OpenClaw support was dropped entirely — it must never appear anywhere.
  assert.doesNotMatch(calls, /openclaw/i, 'openclaw must not appear — support was removed');

  rmSync(tmp, { recursive: true, force: true });
});

test('installs the persistent service when OURS_SERVICE=yes', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'installer-'));
  const bin = join(tmp, 'bin');
  execFileSync('mkdir', ['-p', bin]);
  const log = join(tmp, 'calls.log');
  writeFileSync(log, '');
  fakeBins(bin, ['npm', 'ours-mcp'], { daemonRunning: true });

  execFileSync('bash', [INSTALL], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALLLOG: log,
      OURS_ASSUME_YES: '1', OURS_SERVICE: 'yes', OURS_HARNESSES: 'none' },
    stdio: 'pipe',
  });

  const calls = readFileSync(log, 'utf8');
  assert.match(calls, /ours-mcp install-service/, 'service must be installed');
  // daemon already "running" → not restarted
  assert.doesNotMatch(calls, /ours-mcp start/, 'running daemon should not be restarted');
  rmSync(tmp, { recursive: true, force: true });
});

test('truly-headless (no controlling tty, no OURS_HARNESSES) does the safe skip, not exit 1', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'installer-'));
  const bin = join(tmp, 'bin');
  execFileSync('mkdir', ['-p', bin]);
  const log = join(tmp, 'calls.log');
  writeFileSync(log, '');
  fakeBins(bin, ['npm', 'ours-mcp'], { daemonRunning: true });

  // `setsid` detaches from the controlling terminal, so /dev/tty cannot be opened — the true
  // headless/CI case. With no OURS_HARNESSES and no OURS_ASSUME_YES the installer must reach
  // the documented "no terminal … skipping harness setup" branch and exit 0, NOT crash trying
  // to prompt on an unopenable /dev/tty. `--wait` so we get the child's real exit status.
  const out = execFileSync('setsid', ['--wait', 'bash', INSTALL], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALLLOG: log },
    stdio: 'pipe', encoding: 'utf8',
  }); // execFileSync throws if exit code is non-zero — a regression would fail here.
  assert.match(out, /no terminal and no OURS_HARNESSES set/, 'must take the documented safe-skip branch');
  const calls = readFileSync(log, 'utf8');
  assert.doesNotMatch(calls, /ours-\w+-install/, 'no harness installer should run headless');
  rmSync(tmp, { recursive: true, force: true });
});

test('claude-code selection prints marketplace steps, does not need a shell bin', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'installer-'));
  const bin = join(tmp, 'bin');
  execFileSync('mkdir', ['-p', bin]);
  const log = join(tmp, 'calls.log');
  writeFileSync(log, '');
  fakeBins(bin, ['npm', 'ours-mcp'], { daemonRunning: true });

  const out = execFileSync('bash', [INSTALL], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALLLOG: log,
      OURS_ASSUME_YES: '1', OURS_SERVICE: 'no', OURS_HARNESSES: 'claude-code' },
    stdio: 'pipe', encoding: 'utf8',
  });
  assert.match(out, /\/plugin marketplace add adapt-toolkit\/ours-claude-marketplace/, 'prints marketplace add');
  assert.match(out, /\/plugin install ours$/m, 'prints plugin install (plugin name is "ours")');
  assert.doesNotMatch(out, /\/plugin install ours\.network/, 'plugin token is "ours", not the marketplace name "ours.network"');
  rmSync(tmp, { recursive: true, force: true });
});

// --- interactive toggle UI (needs a real pty; skipped where python3 is unavailable) ----------
function hasPython3() {
  try { execFileSync('python3', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

test('interactive toggle UI: broker/port defaults then arrow/space/enter selects harnesses',
  { skip: hasPython3() ? false : 'python3 not available for pty' }, () => {
  const tmp = mkdtempSync(join(tmpdir(), 'installer-'));
  const bin = join(tmp, 'bin');
  execFileSync('mkdir', ['-p', bin]);
  const log = join(tmp, 'calls.log');
  writeFileSync(log, '');
  fakeBins(bin, ['npm', 'ours-mcp', 'ours-hermes-install', 'ours-codex-install']);
  const driver = join(HERE, 'pty-toggle-driver.py');

  // Flow order (v2): daemon → service(env=no) → BROKER prompt → PORT prompt → harness checkbox.
  // Keys: enter (keep broker default) · enter (keep port default) · then the checkbox — options
  // claude-code(0) codex(1) hermes(2), cursor at 0: down→codex, space, down→hermes, space, enter.
  // No OURS_HARNESSES / OURS_ASSUME_YES → the installer MUST prompt interactively. OURS_CONFIG →
  // a throwaway path so "keep default" (which writes nothing) can't touch the real ~/.ours.
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALLLOG: log, OURS_SERVICE: 'no',
    OURS_CONFIG: join(tmp, 'config.json'), TERM: 'xterm-256color' };
  delete env.OURS_HARNESSES; delete env.OURS_ASSUME_YES; delete env.OURS_IDENTITIES;
  delete env.OURS_BROKER; delete env.OURS_BROKER_URL; delete env.OURS_PORT; delete env.NO_COLOR;
  // execFileSync returning at all proves the run COMPLETED — it never blocked on a prompt.
  const seen = execFileSync('python3', [driver, INSTALL, 'enter,enter,down,space,down,space,enter'],
    { env, encoding: 'utf8' });

  const calls = readFileSync(log, 'utf8');
  assert.match(calls, /ours-codex-install/, 'codex toggled on → installed');
  assert.match(calls, /ours-hermes-install/, 'hermes toggled on → installed');
  assert.match(seen, /Step 1 of 4/, 'upgrade wizard counts its own (shorter) step list');
  assert.doesNotMatch(calls, /--identities/, 'no --identities forwarded');
  assert.doesNotMatch(seen, /openclaw/i, 'openclaw must not appear — support was removed');
  // The toggle UI itself rendered (checkbox glyphs), confirming we exercised the interactive path.
  assert.match(seen, /\[x\]|\[ \]/, 'the checkbox toggle UI should have rendered');
  // Keeping the broker/port defaults must persist nothing to the throwaway config.
  assert.ok(!existsSync(join(tmp, 'config.json')), 'keeping defaults must not write config.json');
  rmSync(tmp, { recursive: true, force: true });
});

// --- consent gate: a FIRST daemon install needs explicit consent (or OURS_ASSUME_YES=1) ---------
test('first install, headless, no OURS_ASSUME_YES: explains the daemon, installs nothing, exit 0', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'installer-'));
  const bin = join(tmp, 'bin');
  execFileSync('mkdir', ['-p', bin]);
  const log = join(tmp, 'calls.log');
  writeFileSync(log, '');
  // Daemon NOT installed: the fake shadows any real ours-mcp and fails every probe.
  fakeBins(bin, ['npm', 'ours-mcp'], { notInstalled: true });

  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALLLOG: log };
  delete env.OURS_ASSUME_YES; delete env.OURS_HARNESSES;
  // setsid → no controlling tty, so consent cannot be asked → the safe default is NOT installing.
  // execFileSync throws on non-zero exit, so returning at all proves the graceful exit 0.
  const out = execFileSync('setsid', ['--wait', 'bash', INSTALL], { env, stdio: 'pipe', encoding: 'utf8' });

  assert.match(out, /shared background process/, 'describes what the daemon is before asking');
  assert.match(out, /nothing was installed/, 'says clearly that nothing was installed');
  const calls = readFileSync(log, 'utf8');
  assert.doesNotMatch(calls, /npm i -g @ours\.network\/mcp/, 'daemon must not be installed without consent');
  assert.doesNotMatch(calls, /ours-mcp start/, 'daemon must not be started without consent');
  assert.doesNotMatch(calls, /ours-mcp create-root/, 'no root identity without consent');
  assert.doesNotMatch(out, /next steps/i, 'no next-steps panel when nothing was installed');
  assert.doesNotMatch(out, /\x1b\[\?1049/, 'no alt-screen wizard without a tty');
  rmSync(tmp, { recursive: true, force: true });
});

test('first install with OURS_ASSUME_YES=1: installs the daemon without prompting', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'installer-'));
  const bin = join(tmp, 'bin');
  execFileSync('mkdir', ['-p', bin]);
  const log = join(tmp, 'calls.log');
  writeFileSync(log, '');
  fakeBins(bin, ['npm', 'ours-mcp'], { notInstalled: true });

  const out = execFileSync('bash', [INSTALL], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALLLOG: log,
      OURS_ASSUME_YES: '1', OURS_SERVICE: 'no', OURS_HARNESSES: 'none' },
    stdio: 'pipe', encoding: 'utf8',
  });

  const calls = readFileSync(log, 'utf8');
  assert.match(calls, /npm i -g @ours\.network\/mcp@latest/, 'daemon installed');
  assert.match(calls, /ours-mcp create-root \S/, 'root identity created (default: the OS username)');
  assert.doesNotMatch(out, /Install it now\?/, 'no consent prompt with the explicit env override');
  assert.match(out, /next steps/i, 'first install ends with the next-steps panel');
  assert.match(out, /Your identity .+ is set up/, 'panel names the freshly created root identity');
  rmSync(tmp, { recursive: true, force: true });
});

test('already installed: no consent prompt, no next-steps panel, daemon still ensured @latest', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'installer-'));
  const bin = join(tmp, 'bin');
  execFileSync('mkdir', ['-p', bin]);
  const log = join(tmp, 'calls.log');
  writeFileSync(log, '');
  fakeBins(bin, ['npm', 'ours-mcp'], { daemonRunning: true });

  const out = execFileSync('bash', [INSTALL], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALLLOG: log,
      OURS_ASSUME_YES: '1', OURS_SERVICE: 'no', OURS_HARNESSES: 'none' },
    stdio: 'pipe', encoding: 'utf8',
  });

  assert.doesNotMatch(out, /shared background process/, 'no consent copy when already installed');
  assert.doesNotMatch(out, /Install it now\?/, 'no consent prompt when already installed');
  assert.doesNotMatch(out, /next steps/i, 'no next-steps panel on an upgrade run');
  const calls = readFileSync(log, 'utf8');
  assert.match(calls, /npm i -g @ours\.network\/mcp@latest/, 'still ensures @latest');
  assert.doesNotMatch(calls, /ours-mcp create-root/, 'no root identity creation on an upgrade run');
  rmSync(tmp, { recursive: true, force: true });
});

test('interactive first install: declining installs nothing',
  { skip: hasPython3() ? false : 'python3 not available for pty' }, () => {
  const tmp = mkdtempSync(join(tmpdir(), 'installer-'));
  const bin = join(tmp, 'bin');
  execFileSync('mkdir', ['-p', bin]);
  const log = join(tmp, 'calls.log');
  writeFileSync(log, '');
  fakeBins(bin, ['npm', 'ours-mcp'], { notInstalled: true });
  const driver = join(HERE, 'pty-toggle-driver.py');

  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALLLOG: log, TERM: 'xterm-256color',
    OURS_SERVICE: 'no', OURS_HARNESSES: 'none', OURS_CONFIG: join(tmp, 'config.json') };
  delete env.OURS_ASSUME_YES; delete env.NO_COLOR;
  const seen = execFileSync('python3', [driver, INSTALL, 'n,enter'], { env, encoding: 'utf8', timeout: 90_000 });

  assert.match(seen, /shared background process/, 'describes what the daemon is');
  assert.match(seen, /Install it now\?/, 'asks for explicit consent');
  assert.match(seen, /\x1b\[\?1049h/, 'interactive run is a wizard on the alternate screen buffer');
  assert.match(seen, /\x1b\[\?1049l/, 'main screen buffer restored on decline');
  assert.ok(seen.indexOf('nothing was installed') > seen.indexOf('\x1b[?1049l'),
    'the decline message lands on the MAIN screen so it survives the wizard closing');
  const calls = readFileSync(log, 'utf8');
  assert.doesNotMatch(calls, /npm i -g @ours\.network\/mcp/, 'decline must not install the daemon');
  assert.doesNotMatch(calls, /ours-mcp start/, 'decline must not start the daemon');
  assert.doesNotMatch(calls, /ours-mcp create-root/, 'decline must not create a root identity');
  rmSync(tmp, { recursive: true, force: true });
});

test('interactive first install: consenting installs the daemon and shows the next-steps panel',
  { skip: hasPython3() ? false : 'python3 not available for pty' }, () => {
  const tmp = mkdtempSync(join(tmpdir(), 'installer-'));
  const bin = join(tmp, 'bin');
  execFileSync('mkdir', ['-p', bin]);
  const log = join(tmp, 'calls.log');
  writeFileSync(log, '');
  fakeBins(bin, ['npm', 'ours-mcp'], { notInstalled: true });
  const driver = join(HERE, 'pty-toggle-driver.py');

  // Keys: y+enter answer the consent prompt; the next enter accepts the default (OS username) at
  // the root-identity name prompt; the last two keep the broker/port defaults.
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALLLOG: log, TERM: 'xterm-256color',
    OURS_SERVICE: 'no', OURS_HARNESSES: 'none', OURS_CONFIG: join(tmp, 'config.json') };
  delete env.OURS_ASSUME_YES; delete env.NO_COLOR;
  const seen = execFileSync('python3', [driver, INSTALL, 'y,enter,enter,enter,enter'], { env, encoding: 'utf8', timeout: 90_000 });

  assert.match(seen, /Install it now\?/, 'asks for explicit consent');
  assert.match(seen, /Your name/, 'asks for the person\'s name for the root identity');
  const calls = readFileSync(log, 'utf8');
  assert.match(calls, /npm i -g @ours\.network\/mcp@latest/, 'consent → daemon installed');
  assert.match(calls, /ours-mcp create-root \S/, 'root identity created with the accepted default name');
  assert.match(seen, /\x1b\[\?1049h/, 'interactive run is a wizard on the alternate screen buffer');
  assert.match(seen, /Step 1 of 5/, 'wizard shows a progress indicator');
  assert.match(seen, /Step 2 of 5/, 'the name prompt is its own wizard step');
  assert.match(seen, /next steps/i, 'first install ends with the next-steps panel');
  assert.match(seen, /Your identity .+ is set up/, 'panel names the freshly created root identity');
  assert.ok(seen.indexOf('next steps') > seen.indexOf('\x1b[?1049l'),
    'summary + panel land on the MAIN screen so they survive the wizard closing');
  rmSync(tmp, { recursive: true, force: true });
});

// --- install.sh bootstrap: Node.js check -------------------------------------------------------
test('install.sh with no Node.js prints friendly per-OS guidance and exits 0', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'installer-'));
  const bin = join(tmp, 'bin');
  execFileSync('mkdir', ['-p', bin]);
  // A PATH with coreutils but NO `node` → the bootstrap must hit the guidance branch. `command`,
  // `printf` are bash builtins; `uname` is guarded. execFileSync throws on non-zero, so a clean
  // return proves exit 0.
  const out = execFileSync('bash', [INSTALL], {
    env: { PATH: '/usr/bin:/bin' + `:${bin}`, HOME: tmp },
    stdio: 'pipe', encoding: 'utf8',
  }).toString();
  // Ensure node truly wasn't found (guard against a system node on /usr/bin leaking in).
  let hasNode = true;
  try { execFileSync('bash', ['-c', 'command -v node'], { env: { PATH: '/usr/bin:/bin' }, stdio: 'ignore' }); }
  catch { hasNode = false; }
  if (hasNode) { rmSync(tmp, { recursive: true, force: true }); return; } // environment has node on /usr/bin; skip
  assert.match(out, /Node\.js/, 'explains Node.js is needed');
  assert.match(out, /nodejs\.org/, 'links nodejs.org');
  assert.doesNotMatch(out, /install\.mjs/, 'must not try to run the Node installer without node');
  rmSync(tmp, { recursive: true, force: true });
});

// --- broker/port: env-driven values are written to config.json + the daemon restarts -----------
test('OURS_BROKER/OURS_PORT are written to config.json and the daemon is restarted', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'installer-'));
  const bin = join(tmp, 'bin');
  execFileSync('mkdir', ['-p', bin]);
  const log = join(tmp, 'calls.log');
  writeFileSync(log, '');
  const cfg = join(tmp, 'config.json');
  fakeBins(bin, ['npm', 'ours-mcp'], { daemonRunning: true });

  execFileSync('bash', [INSTALL], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALLLOG: log,
      OURS_ASSUME_YES: '1', OURS_SERVICE: 'no', OURS_HARNESSES: 'none',
      OURS_BROKER: 'wss://custom.example', OURS_PORT: '3060', OURS_CONFIG: cfg },
    stdio: 'pipe',
  });

  assert.ok(existsSync(cfg), 'config.json should be written');
  const parsed = JSON.parse(readFileSync(cfg, 'utf8'));
  assert.equal(parsed.brokerUrl, 'wss://custom.example', 'broker persisted');
  assert.equal(parsed.port, 3060, 'port persisted');
  assert.match(readFileSync(log, 'utf8'), /ours-mcp restart/, 'daemon restarted to apply new config');
  rmSync(tmp, { recursive: true, force: true });
});

// --- never hand out the Telegram connector's reserved port 3051 --------------------------------
test('OURS_PORT=3051 is refused in favour of a non-reserved alternate', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'installer-'));
  const bin = join(tmp, 'bin');
  execFileSync('mkdir', ['-p', bin]);
  const log = join(tmp, 'calls.log');
  writeFileSync(log, '');
  const cfg = join(tmp, 'config.json');
  fakeBins(bin, ['npm', 'ours-mcp'], { daemonRunning: true });

  execFileSync('bash', [INSTALL], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALLLOG: log,
      OURS_ASSUME_YES: '1', OURS_SERVICE: 'no', OURS_HARNESSES: 'none',
      OURS_PORT: '3051', OURS_CONFIG: cfg },
    stdio: 'pipe',
  });

  assert.ok(existsSync(cfg), 'config.json should be written with the alternate port');
  const parsed = JSON.parse(readFileSync(cfg, 'utf8'));
  assert.notEqual(parsed.port, 3051, 'must never persist the reserved port 3051');
  rmSync(tmp, { recursive: true, force: true });
});
