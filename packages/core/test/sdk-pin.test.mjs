// packages/core/test/sdk-pin.test.mjs
// bump-versions.sh cannot manage a cross-repo dependency (its MANAGED array at
// line 46 is hard-coded to this repo's five packages), so the pin must be EXACT.
// A range would let a release resolve to an SDK nobody gated.
//
// This test also pins the SHAPE of the dependency, not just its value: a
// `file:` or `link:` pin would make CI green on a developer's machine and
// produce an uninstallable tarball for everyone else. While ours-sdk is
// unpublished, the honest state is a pin that 404s — see scripts/link-local-sdk.sh.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const pin = pkg.dependencies['@ours.network/sdk'];

assert.ok(pin, '@ours.network/sdk must be a dependency');
assert.match(pin, /^\d+\.\d+\.\d+$/, `SDK pin must be an exact version, got "${pin}"`);
assert.doesNotMatch(pin, /^(file|link|git|https?):/,
  'the SDK pin must never be committed as a local path — that publishes an uninstallable package');
assert.equal(pkg.dependencies['@adapt-toolkit/sdk'], undefined, 'ours-mcp must not depend on the ADAPT SDK');
assert.equal(pkg.dependencies['@adapt-toolkit/sdk-native'], undefined, 'ours-mcp must not depend on the ADAPT native SDK');

console.log(`sdk-pin OK (@ours.network/sdk pinned exactly at ${pin})`);
