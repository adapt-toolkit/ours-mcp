#!/usr/bin/env bash
# Build the unpublished review SDK from an immutable source revision before npm ci.
set -euo pipefail
repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
artifact_dir=$(cd -- "${1:-$repo_root/..}" && pwd)
source_dir=$(mktemp -d)
trap 'rm -rf -- "$source_dir"' EXIT
sdk_revision=d910ab912ca6e6fa835dfe97751500363d9396dc
git -C "$source_dir" init -q
git -C "$source_dir" remote add origin https://github.com/adapt-toolkit/ours-sdk.git
git -c credential.helper='!gh auth git-credential' -C "$source_dir" fetch --depth=1 origin "$sdk_revision"
git -C "$source_dir" checkout --detach FETCH_HEAD
test "$(git -C "$source_dir" rev-parse HEAD)" = "$sdk_revision"
(
  cd -- "$source_dir"
  unset GH_TOKEN
  npm ci --ignore-scripts
  npm run build
  npm pack --ignore-scripts --pack-destination "$artifact_dir"
)

node "$repo_root/scripts/normalize-review-tarball.mjs" "$artifact_dir/ours.network-sdk-3.8.1-supervisor.0.tgz"
