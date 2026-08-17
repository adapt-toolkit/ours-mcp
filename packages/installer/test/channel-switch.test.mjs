// THE ACCEPTANCE PROOF FOR THE CHANNEL SWITCH — by EXECUTION, not by reasoning.
//
// Every other test in this suite imports a function and injects its effects. That
// proves what the function does; it proves NOTHING about which branch the bin
// takes, and "which branch does CHANNEL=nightly take" is the entire question here.
// So these spawn the real `install.mjs` and `uninstall.mjs` as child processes,
// with real effects, and read what actually came out.
//
// ─── HOW THIS STAYS OFF THE OWNER'S LIVE DAEMON ──────────────────────────────
//
// This host runs the live fleet, a daemon on 127.0.0.1:3050 and the owner's
// messenger. Tests reaching that daemon has already been a real finding here, so
// the mechanism below is a BARRIER rather than an intention to be careful:
//
//   · HOME is an mkdtemp directory, so every path the installer derives is inside
//     it.
//   · <tmp-home>/.ours/config.json is SEEDED with the port of a fake daemon this
//     file starts on an EPHEMERAL port (listen(0), 127.0.0.1). lib/target.mjs's
//     findDaemon reads the recorded port from that config and probes only it, so
//     the built-in default — 3050 — is never probed.
//   · --dry-run: under v3 `perform()` performs nothing, so no subprocess runs and
//     no file is written. That also removes any need for fake npm/ours binaries.
//   · PATH is a temp directory plus /usr/bin:/bin, so `claude`, `codex` and
//     `hermes` are genuinely absent and harness detection is deterministic. SHELL
//     is pinned to /bin/sh so the alias probe cannot source this host's rc.
//
// ─── WHAT THIS DOES NOT PROVE, STATED RATHER THAN IMPLIED ────────────────────
//
// The CREATE path is NOT execution-proved. With no recorded port, findDaemon
// probes the built-in default — 3050, the live daemon — and the free-port search
// would bind upward from 3050 as well. Forcing it would need a test-only
// environment seam in daemon detection, and a hole in production code to make a
// test easier is exactly the seam that later becomes a way to misconfigure a real
// install. Create stays proved by the unit tests in target.test.mjs and
// orchestrate.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const INSTALL_BIN = join(HERE, '..', 'install.mjs');
const UNINSTALL_BIN = join(HERE, '..', 'uninstall.mjs');

/** A daemon that answers /state-dir, on a port the OS picks. Never 3050. */
async function fakeDaemon(stateDir) {
  const server = createServer((req, res) => {
    if (req.url === '/state-dir') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ stateDir }));
      return;
    }
    res.writeHead(404).end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}

function seededHome(port) {
  const home = mkdtempSync(join(tmpdir(), 'ours-switch-'));
  const stateDir = join(home, '.ours');
  mkdirSync(stateDir, { recursive: true });
  // The barrier: a RECORDED port, so findDaemon never falls back to 3050.
  writeFileSync(join(stateDir, 'config.json'), `${JSON.stringify({ port, stateDir }, null, 2)}\n`);
  return { home, stateDir };
}

function runBin(bin, args, home) {
  const emptyBin = mkdtempSync(join(tmpdir(), 'ours-nopath-'));
  try {
    return spawnSync(process.execPath, [bin, ...args], {
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        HOME: home,
        PATH: `${emptyBin}:/usr/bin:/bin`,
        SHELL: '/bin/sh',
        OURS_CHANNEL: 'nightly',
        OURS_ASSUME_YES: '1',
        NODE_OPTIONS: '',
      },
    });
  } finally {
    rmSync(emptyBin, { recursive: true, force: true });
  }
}

// The nightly flow's own screens. Their ABSENCE is the assertion that matters: a
// bin that somehow ran BOTH would sail through a presence-only check, and "both
// ran" is a plausible way for a dispatch edit to go wrong.
const NIGHTLY_INSTALL_MARKERS = [/Nightly daemon profiles/, /Review Nightly topology/, /Nightly install complete/];
const NIGHTLY_UNINSTALL_MARKERS = [/Nightly profile-aware uninstall/, /Nightly uninstall complete/];

test('CHANNEL=nightly runs the V3 installer, and does not run the nightly flow', async () => {
  const daemon = await fakeDaemon('/does-not-matter');
  const { home, stateDir } = seededHome(daemon.port);
  try {
    const r = runBin(INSTALL_BIN, ['--dry-run'], home);
    assert.equal(r.status, 0, `exit 0; stderr was: ${r.stderr}`);
    const out = `${r.stdout}${r.stderr}`;

    // v3's own walk, by its phase output rather than by decoration.
    assert.match(out, /Checking your machine/, "v3's preflight ran");
    assert.match(out, new RegExp(`target ${stateDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), 'v3 named the target state directory');
    assert.match(out, /dry-run: nothing will be installed or changed/, "v3's dry-run banner");
    assert.match(out, /ours\.network — install complete/, "v3's end screen");

    for (const marker of NIGHTLY_INSTALL_MARKERS) {
      assert.doesNotMatch(out, marker, `the nightly flow must NOT have run: ${marker}`);
    }
    // And the barrier held: nothing about the default port appears, because it was
    // never probed.
    assert.doesNotMatch(out, /3050/, 'the built-in default port was never involved');
  } finally {
    await daemon.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('CHANNEL=nightly runs the V3 uninstaller, and does not run the nightly flow', async () => {
  const daemon = await fakeDaemon('/does-not-matter');
  const { home, stateDir } = seededHome(daemon.port);
  try {
    const r = runBin(UNINSTALL_BIN, ['--dry-run', '--state-dir', stateDir], home);
    assert.equal(r.status, 0, `exit 0; stderr was: ${r.stderr}`);
    const out = `${r.stdout}${r.stderr}`;

    assert.match(out, /ours-uninstall --state-dir/, "v3's uninstall heading");
    assert.match(out, /dry-run: nothing will be removed or stopped/);
    for (const marker of NIGHTLY_UNINSTALL_MARKERS) {
      assert.doesNotMatch(out, marker, `the nightly flow must NOT have run: ${marker}`);
    }
    // The v2 uninstall body is still there for stable and must not have run either.
    assert.doesNotMatch(out, /ours\.network uninstaller/, "v2's banner belongs to the stable body");
  } finally {
    await daemon.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('--help, --version and their short forms still work on the nightly channel', async () => {
  // The three flags a user actually types. If any of them errored where it used to
  // work, that would be a bug introduced by the switch rather than a known gap.
  const daemon = await fakeDaemon('/does-not-matter');
  const { home } = seededHome(daemon.port);
  try {
    for (const [flag, expected] of [
      ['--help', /ours-install/],
      ['-h', /ours-install/],
      ['--version', /ours-install v/],
      ['-V', /ours-install v/],
    ]) {
      const r = runBin(INSTALL_BIN, [flag], home);
      assert.equal(r.status, 0, `${flag} exits 0`);
      assert.match(`${r.stdout}${r.stderr}`, expected, `${flag} printed something useful`);
    }
    for (const flag of ['--help', '--version']) {
      const r = runBin(UNINSTALL_BIN, [flag], home);
      assert.equal(r.status, 0, `uninstall ${flag} exits 0`);
      assert.match(`${r.stdout}${r.stderr}`, /ours-uninstall/, `uninstall ${flag} printed something useful`);
    }
  } finally {
    await daemon.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('the STABLE channel still runs the v2 body, untouched', async () => {
  // The other half of the switch being safe: nothing a stable user does changes.
  // --help is enough to prove which body answered, and it starts nothing.
  const daemon = await fakeDaemon('/does-not-matter');
  const { home } = seededHome(daemon.port);
  try {
    const emptyBin = mkdtempSync(join(tmpdir(), 'ours-nopath-'));
    const r = spawnSync(process.execPath, [INSTALL_BIN, '--help'], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { HOME: home, PATH: `${emptyBin}:/usr/bin:/bin`, SHELL: '/bin/sh', OURS_CHANNEL: 'latest', OURS_ASSUME_YES: '1' },
    });
    rmSync(emptyBin, { recursive: true, force: true });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Guided ~3-minute setup/, "v2's usage, which only the v2 body prints");
  } finally {
    await daemon.close();
    rmSync(home, { recursive: true, force: true });
  }
});
