import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const installerDir = join(dirname(fileURLToPath(import.meta.url)), '..');

test('latest/stable installer body remains behind an early Nightly-only fork and has no registry/application wiring', () => {
  const source = readFileSync(join(installerDir, 'install.mjs'), 'utf8');
  const preflight = source.indexOf('const anyHarness =');
  const gate = source.indexOf("if (CHANNEL === 'nightly')", preflight);
  const stableStart = source.indexOf('// Daemon state up front', gate);
  assert.ok(preflight > 0 && gate > preflight && stableStart > gate, 'Nightly forks only after existing harness preflight');
  const stableBody = source.slice(stableStart);
  assert.doesNotMatch(stableBody, /installer-profiles\.json|profilesPath\(|readRegistry\(|writeRegistry\(/);
  assert.doesNotMatch(stableBody, /--application/);
  assert.match(source.slice(gate, stableStart), /return runNightlyInstaller/);
});

test('latest/stable uninstall body remains behind the Nightly-only fork', () => {
  const source = readFileSync(join(installerDir, 'uninstall.mjs'), 'utf8');
  const gate = source.indexOf("if (CHANNEL === 'nightly')");
  const stableStart = source.indexOf('// --- 1) choose what to remove', gate);
  assert.ok(gate > 0 && stableStart > gate);
  const stableBody = source.slice(stableStart);
  assert.doesNotMatch(stableBody, /installer-profiles\.json|profilesPath\(|readRegistry\(|writeRegistry\(/);
  assert.match(source.slice(gate, stableStart), /return runNightlyUninstaller/);
});
