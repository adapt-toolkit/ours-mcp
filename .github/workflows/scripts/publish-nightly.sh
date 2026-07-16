#!/usr/bin/env bash
#
# The ONLY way this repo publishes a nightly. Atomically: run the fail-closed guard, then
# `npm publish --tag nightly`. The `--tag nightly` is hardcoded here and the guard runs in the
# same process, so there is no arrangement of CI steps that publishes a nightly to any other tag
# (in particular never the default @latest) — a nightly either reaches the `nightly` tag or fails.
#
# Usage: publish-nightly.sh <workspace-name>
#   e.g. publish-nightly.sh @ours.network/mcp
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

workspace="${1:?usage: publish-nightly.sh <@ours.network/workspace>}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Resolve the workspace's package.json by matching name across packages/*/package.json.
pkg_json="$(node -e '
  const fs=require("fs"), path=require("path");
  const want=process.argv[1], root="packages";
  for (const d of fs.readdirSync(root)) {
    const p=path.join(root,d,"package.json");
    if (fs.existsSync(p) && JSON.parse(fs.readFileSync(p)).name===want) { process.stdout.write(p); break; }
  }
' "$workspace")"
[[ -n "$pkg_json" && -f "$pkg_json" ]] || { echo "publish-nightly: cannot locate package.json for $workspace" >&2; exit 1; }

# Fail closed BEFORE the publish: version must be -nightly.N and the tag must be `nightly`.
bash "$here/publish-guard.sh" nightly "$pkg_json" nightly

npm publish --workspace "$workspace" --tag nightly --access public
