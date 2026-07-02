#!/usr/bin/env bash
#
# Publish the ours-mcp packages to npm from a local machine, in dependency
# order: @ours.network/mcp (server) first, then @ours.network/claude-code
# (plugin, which pins the server). Stand-in for the GitHub `publish.yml` while
# CI is unavailable; mirrors its steps: clean install -> typecheck -> build ->
# publish both workspaces.
#
# Reads the npm token from a gitignored .env (NPM_TOKEN=...; see .env.example).
# The token is written only to a throwaway npmrc deleted on exit, so it never
# touches a tracked file or your ~/.npmrc.
#
# Versioning is manual: bump "version" in packages/core and packages/claude-code
# before publishing (npm refuses to republish an existing version). Keep the
# plugin's "@ours.network/mcp" dependency pin equal to the core version you
# publish — this script aborts if they disagree. Pass --dry-run to validate the
# tarballs without publishing.
#
#   ./publish-local.sh            # publish both
#   ./publish-local.sh --dry-run  # pack + validate only
set -euo pipefail
cd "$(dirname "$0")"

if [ -f .env ]; then set -a; . ./.env; set +a; fi
: "${NPM_TOKEN:?NPM_TOKEN not set — copy .env.example to .env and fill it in}"

NPMRC="$(mktemp)"; trap 'rm -f "$NPMRC"' EXIT
printf '//registry.npmjs.org/:_authToken=%s\n' "$NPM_TOKEN" > "$NPMRC"
export NPM_CONFIG_USERCONFIG="$NPMRC"

# Guard: the plugin must pin the exact core version being published, or the
# published plugin would reference an unpublished/wrong @ours.network/mcp.
core_ver=$(node -p "require('./packages/core/package.json').version")
plugin_pin=$(node -p "require('./packages/claude-code/package.json').dependencies['@ours.network/mcp']")
if [ "$plugin_pin" != "$core_ver" ]; then
  echo "✗ plugin pins @ours.network/mcp@${plugin_pin} but core is ${core_ver}." >&2
  echo "  Set packages/claude-code/package.json dependency to ${core_ver} and re-run." >&2
  exit 1
fi

npm ci
npm run typecheck
npm run build

# Server first, then plugin (--access public is also set via each package's
# publishConfig; passed here too for clarity). "$@" forwards e.g. --dry-run.
npm publish --workspace @ours.network/mcp --access public "$@"
npm publish --workspace @ours.network/claude-code --access public "$@"

echo "✓ @ours.network/mcp@${core_ver} + @ours.network/claude-code"
