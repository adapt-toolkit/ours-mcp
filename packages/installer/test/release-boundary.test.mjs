import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const installerDir = join(dirname(fileURLToPath(import.meta.url)), '..');

// REWRITTEN, NOT DELETED, AND THE PREMISE IS WHAT CHANGED.
//
// These asserted that the nightly channel forked into `runNightlyInstaller` /
// `runNightlyUninstaller` — the arrangement the owner's 2026-08-17 ruling
// removes. A test whose premise has been reversed cannot simply be made to pass;
// it has to say what is true NOW. What is still worth pinning is the half that
// did not change: the stable body must remain reachable and must stay free of
// the registry and --application wiring, so a stable user's run is unaffected by
// anything the nightly channel does.

test('the nightly channel forks into the V3 installer, before anything else in main()', () => {
  const source = readFileSync(join(installerDir, 'install.mjs'), 'utf8');
  const mainStart = source.indexOf('async function main()');
  const gate = source.indexOf("if (CHANNEL === 'nightly')", mainStart);
  const help = source.indexOf("argv.includes('--help')", mainStart);
  assert.ok(mainStart > 0 && gate > mainStart, 'the fork is inside main()');
  assert.match(source.slice(gate, gate + 400), /runInstallV3\(/, 'nightly runs v3, not the old topology-first flow');
  // BEFORE --help, deliberately: whatever prints the help must be whatever runs,
  // and the v2 usage describes v2's flags.
  assert.ok(gate < help, 'the fork comes before --help/--version are answered');
  assert.doesNotMatch(source, /runNightlyInstaller/, 'nothing dispatches into the old flow any more');
});

test('the latest/stable body is still there, and still free of registry/application wiring', () => {
  const source = readFileSync(join(installerDir, 'install.mjs'), 'utf8');
  const stableStart = source.indexOf('// Daemon state up front');
  assert.ok(stableStart > 0, 'the v2 body still serves the stable channel');
  const stableBody = source.slice(stableStart);
  assert.doesNotMatch(stableBody, /installer-profiles\.json|profilesPath\(|readRegistry\(|writeRegistry\(/);
  assert.doesNotMatch(stableBody, /--application/);
});

test('the uninstall bin forks the same way, and its stable body survives', () => {
  const source = readFileSync(join(installerDir, 'uninstall.mjs'), 'utf8');
  const gate = source.indexOf("if (CHANNEL === 'nightly')");
  const stableStart = source.indexOf('// --- 1) choose what to remove', gate);
  assert.ok(gate > 0 && stableStart > gate);
  assert.match(source.slice(gate, gate + 400), /runUninstallV3\(/);
  assert.doesNotMatch(source, /runNightlyUninstaller/);
  assert.doesNotMatch(source.slice(stableStart), /installer-profiles\.json|profilesPath\(|readRegistry\(|writeRegistry\(/);
});
