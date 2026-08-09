#!/usr/bin/env bash
# Install @ours.network/sdk from a LOCAL ours-sdk checkout, for development only.
#
# ============================================================================
# OBSOLETE AS OF @ours.network/sdk 0.1.1 — AND USING IT NOW HIDES REAL FAILURES
# ============================================================================
# The SDK IS on npm. `npm ci` / `npm install` resolves the pin in
# packages/core/package.json from the registry, which is what CI does and what a
# user does. Nothing needs this script.
#
# It is kept only for developing against an UNRELEASED SDK change — and if you
# use it for that, know what you are giving up: it installs a packed local SDK
# under the real package name and then restores package.json exactly as
# committed, so `git status` stays clean while node_modules holds your working
# tree. A green run in that state proves nothing about what a user installing
# from npm gets, which is the exact failure this repo's rules exist to prevent.
#
# packages/core/test/sdk-pin.test.mjs now catches that: it checks the INSTALLED
# package, not just the declared pin — registry provenance from the lockfile, no
# symlink, matching version, and the .muflo packet present in the tarball. Run
# `npm ci` before trusting any green you got after running this.
#
# The original rationale, kept because it is why the pin looks the way it does:
# the pin is deliberately the REAL package and version — not a `file:` path — so
# nothing about this workaround is ever committed.
#
# This script installs a packed tarball of the local SDK into node_modules and
# then puts package.json back exactly as committed. package-lock.json is never
# written (--no-package-lock), so `git status` stays clean afterwards.
#
#   usage: bash scripts/link-local-sdk.sh [/path/to/ours-sdk]
#
# The SDK is published. Delete this script once nobody is developing against an
# unreleased SDK change.
set -euo pipefail

sdk="${1:-/home/fleet/workspaces/Developer-1-sdk/ours-sdk}"
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pkg="$repo/packages/core/package.json"

[ -f "$sdk/package.json" ] || { echo "no ours-sdk checkout at $sdk" >&2; exit 1; }

echo "==> packing the SDK from $sdk"
tgz="$(cd "$sdk" && npm pack --pack-destination /tmp --silent | tail -1)"
tgz="/tmp/$tgz"
echo "    $tgz"

backup="$(mktemp)"; cp "$pkg" "$backup"
restore() { cp "$backup" "$pkg"; rm -f "$backup"; }
trap restore EXIT

echo "==> installing it under the real package name"
node -e '
  const fs = require("fs"), p = process.argv[1], tgz = process.argv[2];
  const d = JSON.parse(fs.readFileSync(p, "utf8"));
  d.dependencies["@ours.network/sdk"] = "file:" + tgz;
  fs.writeFileSync(p, JSON.stringify(d, null, 2) + "\n");
' "$pkg" "$tgz"

(cd "$repo" && npm install --no-package-lock)

# Restore NOW rather than leaving it to the EXIT trap, so the line printed below
# reports the state the developer is actually left in.
restore; trap - EXIT
echo "==> done. package.json is back to the committed pin:"
node -e 'console.log("   ", JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).dependencies["@ours.network/sdk"])' "$pkg"
echo "    node_modules/@ours.network/sdk ->"
ls "$repo/node_modules/@ours.network/sdk" 2>/dev/null | head -5 || echo "    MISSING — install failed"
