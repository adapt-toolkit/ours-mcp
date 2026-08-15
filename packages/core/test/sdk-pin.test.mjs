// packages/core/test/sdk-pin.test.mjs
// bump-versions.sh cannot manage a cross-repo dependency (its MANAGED array at
// line 46 is hard-coded to this repo's five packages), so the pin must be EXACT.
// A range would let a release resolve to an SDK nobody gated.
//
// THIS TEST CHANGED WHEN THE SDK WAS PUBLISHED, AND THE CHANGE IS THE POINT.
// It used to check only the DECLARED pin, with a comment saying "while ours-sdk
// is unpublished, the honest state is a pin that 404s". @ours.network/sdk is on
// npm now, so that excuse is retired and a red CI is just a red CI. Checking the
// declared string is no longer enough on its own: `scripts/link-local-sdk.sh`
// installs a packed local SDK under the real package name and then puts
// package.json back exactly as committed, so the pin can read 0.1.1 while
// node_modules holds a developer's working tree. That is precisely the state
// that makes a green run prove nothing about what a user gets from the registry.
//
// So this gate now asserts BOTH halves: the pin as committed, and the package as
// INSTALLED — resolved from the registry, carrying the .muflo packet, and at the
// pinned version.
import assert from 'node:assert/strict';
import { readFileSync, existsSync, lstatSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const pin = pkg.dependencies['@ours.network/sdk'];

assert.ok(pin, '@ours.network/sdk must be a dependency');
assert.match(pin, /^\d+\.\d+\.\d+$/, `SDK pin must be an exact version, got "${pin}"`);
assert.doesNotMatch(pin, /^(file|link|git|https?):/,
  'the SDK pin must never be committed as a local path — that publishes an uninstallable package');
assert.equal(pkg.dependencies['@adapt-toolkit/sdk'], undefined, 'ours-mcp must not depend on the ADAPT SDK');
assert.equal(pkg.dependencies['@adapt-toolkit/sdk-native'], undefined, 'ours-mcp must not depend on the ADAPT native SDK');

// ----- the installed package, not the declared one ---------------------------
// Resolved through the real module graph, not by guessing a node_modules path —
// otherwise this gate would pass on a directory nothing actually imports.
//
// NOTE, and it is a small finding in its own right: the SDK's exports map has no
// "./package.json" entry, so `require.resolve('@ours.network/sdk/package.json')`
// throws ERR_PACKAGE_PATH_NOT_EXPORTED. Resolve the entry point and walk up to
// the package root instead. Worth adding upstream (it is one line and the
// conventional courtesy), but it is not a defect and this works today.
const require_ = createRequire(import.meta.url);
const sdkDir = (() => {
  let d = dirname(require_.resolve('@ours.network/sdk'));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(d, 'package.json'))) return d;
    d = dirname(d);
  }
  throw new Error('could not locate the installed @ours.network/sdk package root');
})();
const sdkPkgPath = join(sdkDir, 'package.json');
const installed = JSON.parse(readFileSync(sdkPkgPath, 'utf8'));
assert.equal(installed.name, '@ours.network/sdk', `walked up to the wrong package: ${installed.name}`);

assert.equal(installed.version, pin,
  `the INSTALLED SDK is ${installed.version} but the pin says ${pin} — a green run here would be ` +
  'about a version nobody gated');

// A symlink means a workspace link or `npm link`; both make this repo pass
// against a working tree instead of a published artifact.
assert.ok(!lstatSync(sdkDir).isSymbolicLink(),
  `${sdkDir} is a SYMLINK — the SDK is linked, not installed. Green here says nothing about npm.`);

// The registry provenance, read from the lockfile rather than inferred.
{
  const lock = JSON.parse(readFileSync(new URL('../../../package-lock.json', import.meta.url), 'utf8'));
  const entry = lock.packages?.['node_modules/@ours.network/sdk'];
  assert.ok(entry, 'the lockfile has no entry for @ours.network/sdk');
  assert.match(entry.resolved ?? '', /^https:\/\/registry\.npmjs\.org\//,
    `the lockfile resolves the SDK from "${entry.resolved}" — it must come from the registry`);
  assert.equal(entry.version, pin, 'the lockfile version must match the pin');
}

// THE ONE THAT WOULD KILL EVERY CONSUMER AT BOOT. The SDK finds its packet
// relative to import.meta.url, so a tarball published without it dies with
// "no compiled .muflo packet found" — and nothing repo-local would catch that,
// because the file is always on disk in a checkout.
{
  const packetDir = join(sdkDir, 'dist', 'mufl_code');
  assert.ok(existsSync(packetDir), `the installed SDK has no ${packetDir}`);
  const packets = readdirSync(packetDir).filter((f) => f.endsWith('.muflo'));
  assert.equal(packets.length, 1,
    `expected exactly one .muflo in the INSTALLED SDK, found ${packets.length} — a packet-less ` +
    'tarball boots to "no compiled .muflo packet found" for every consumer');
}

console.log(`sdk-pin OK (@ours.network/sdk ${pin} pinned, installed from the registry, packet present)`);
