#!/usr/bin/env bash
# Invite-compatibility gate: the PUBLISHED @ours.network/mcp release against
# this working tree's build — invites in both directions plus first messages,
# two daemon processes on a local dev broker (see test/invite-compat.test.mjs).
#
# Fetches the released artifact from npm (network required) unless
# OLD_OURS_DIR already points at an installed copy. Pin the release under test
# with OLD_OURS_VERSION (default: latest).
#
#   bash scripts/test-invite-compat.sh
#   OLD_OURS_VERSION=0.15.3 bash scripts/test-invite-compat.sh
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
version="${OLD_OURS_VERSION:-latest}"

if [ -z "${OLD_OURS_DIR:-}" ]; then
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT
  echo "installing published @ours.network/mcp@$version …"
  ( cd "$work" && npm init -y >/dev/null 2>&1 && npm install "@ours.network/mcp@$version" >/dev/null 2>&1 )
  OLD_OURS_DIR="$work/node_modules/@ours.network/mcp"
fi

if [ ! -f "$OLD_OURS_DIR/dist/cli.js" ]; then
  echo "error: no released daemon at '$OLD_OURS_DIR' (expected dist/cli.js)." >&2
  exit 1
fi

echo "OLD (released) daemon: $OLD_OURS_DIR"
OLD_OURS_DIR="$OLD_OURS_DIR" node "$repo_root/packages/core/test/invite-compat.test.mjs"
