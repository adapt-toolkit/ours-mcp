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
function fakeBins(dir, names, opts = {}) {
  for (const n of names) {
    const body =
      `#!/bin/bash\n` +
      `printf '%s %s\\n' "${n}" "$*" >> "$CALLLOG"\n` +
      // `ours-mcp status` should fail (so the installer starts it) unless told otherwise
      (n === 'ours-mcp' ? `[ "$1" = "status" ] && exit ${opts.daemonRunning ? 0 : 1}\n` : '') +
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
  fakeBins(bin, ['npm', 'ours-mcp', 'ours-hermes-install', 'ours-codex-install', 'ours-openclaw-install']);

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
  // openclaw was NOT selected
  assert.doesNotMatch(calls, /ours-openclaw-install/, 'unselected harness must not run');

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
  assert.match(out, /\/plugin install ours\.network/, 'prints plugin install');
  rmSync(tmp, { recursive: true, force: true });
});

// --- interactive toggle UI (needs a real pty; skipped where python3 is unavailable) ----------
function hasPython3() {
  try { execFileSync('python3', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

test('interactive toggle UI: arrow/space/enter selects harnesses, asks ZERO identity questions',
  { skip: hasPython3() ? false : 'python3 not available for pty' }, () => {
  const tmp = mkdtempSync(join(tmpdir(), 'installer-'));
  const bin = join(tmp, 'bin');
  execFileSync('mkdir', ['-p', bin]);
  const log = join(tmp, 'calls.log');
  writeFileSync(log, '');
  fakeBins(bin, ['npm', 'ours-mcp', 'ours-hermes-install', 'ours-codex-install', 'ours-openclaw-install']);
  const driver = join(HERE, 'pty-toggle-driver.py');

  // Options render as: claude-code(0) codex(1) hermes(2) openclaw(3), cursor at 0.
  // Keys: down→codex, space(toggle codex), down→hermes, space(toggle hermes), enter.
  // No OURS_HARNESSES / OURS_ASSUME_YES → the installer MUST use the interactive checkbox UI.
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALLLOG: log, OURS_SERVICE: 'no' };
  delete env.OURS_HARNESSES; delete env.OURS_ASSUME_YES; delete env.OURS_IDENTITIES;
  // execFileSync returning at all proves the run COMPLETED — it never blocked on an identity prompt.
  const seen = execFileSync('python3', [driver, INSTALL, 'down,space,down,space,enter'],
    { env, encoding: 'utf8' });

  const calls = readFileSync(log, 'utf8');
  assert.match(calls, /ours-codex-install/, 'codex toggled on → installed');
  assert.match(calls, /ours-hermes-install/, 'hermes toggled on → installed');
  assert.doesNotMatch(calls, /ours-openclaw-install/, 'openclaw left off → not installed');
  assert.doesNotMatch(calls, /--identities/, 'no --identities forwarded');
  // The removed prompt asked "Identities to wake on new mail …" — it must never appear again.
  // (The end-of-run "Optional: get woken on new mail" pointer is fine; this matches only the old
  // interactive prompt wording, which is what we deleted.)
  assert.doesNotMatch(seen, /Identities to wake on new mail/, 'the old identities prompt must be gone');
  // The toggle UI itself rendered (checkbox glyphs), confirming we exercised the interactive path.
  assert.match(seen, /\[x\]|\[ \]/, 'the checkbox toggle UI should have rendered');
  rmSync(tmp, { recursive: true, force: true });
});
