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

test('installs daemon + selected npm harnesses with identities, skips service', () => {
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
      OURS_IDENTITIES: 'Alice Bob',
    },
    stdio: 'pipe',
  });

  const calls = readFileSync(log, 'utf8');
  // daemon started (status failed → start)
  assert.match(calls, /ours-mcp start/, 'daemon should be started');
  // no persistent service (OURS_SERVICE=no)
  assert.doesNotMatch(calls, /install-service/, 'service must be skipped');
  // selected harnesses installed + configured, with identities forwarded
  assert.match(calls, /npm i -g @ours\.network\/codex/, 'codex package installed');
  assert.match(calls, /ours-codex-install/, 'codex installer run');
  assert.match(calls, /npm i -g @ours\.network\/hermes/, 'hermes package installed');
  assert.match(calls, /ours-hermes-install --identities Alice Bob/, 'hermes installer run with identities');
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
