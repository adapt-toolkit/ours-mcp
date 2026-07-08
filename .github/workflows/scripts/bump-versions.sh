#!/usr/bin/env bash
#
# Bumps every publishable @ours.network workspace version in one [skip ci] commit, re-pins
# each plugin's exact internal dependency to the freshly bumped version, refreshes the
# lockfile, and pushes. Each package bumps from max(local, npm-published) so a locally
# published version can never collide.
#
# Managed packages (publish order = dependency order):
#   @ours.network/mcp        packages/core         (no internal deps)
#   @ours.network/claude-code packages/claude-code (pins @ours.network/mcp)
#   @ours.network/hermes     packages/hermes       (no internal deps)
#   @ours.network/openclaw   packages/openclaw     (no internal deps)
#   @ours.network/codex      packages/codex        (no internal deps)
# (packages/installer is private → never bumped or published.)
#
# Bump level comes from the HEAD commit subject (Conventional Commits):
#   feat: minor · fix: patch · !/BREAKING: major
#   refactor/perf/style/build/revert/other: patch · ci/test/docs/chore: none

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# name|json-path|pin-dep (pin-dep empty = none). Order matters: publish/bump in this order.
MANAGED=(
  "@ours.network/mcp|packages/core/package.json|"
  "@ours.network/claude-code|packages/claude-code/package.json|@ours.network/mcp"
  "@ours.network/hermes|packages/hermes/package.json|"
  "@ours.network/openclaw|packages/openclaw/package.json|"
  "@ours.network/codex|packages/codex/package.json|"
)

emit() { [[ -n "${GITHUB_OUTPUT:-}" ]] && printf '%s\n' "$1" >> "$GITHUB_OUTPUT" || true; }
log()  { printf '[bump] %s\n' "$*"; }

no_bump() {
  log "no bump: $1"
  emit "bumped=false"
  emit "new-sha=${GITHUB_SHA:-$(git rev-parse HEAD)}"
  exit 0
}

msg=$(git log -1 --pretty=%B HEAD)
subject=$(printf '%s\n' "$msg" | head -n1)
body=$(printf '%s\n' "$msg" | tail -n +2)
log "head subject: $subject"

printf '%s\n' "$msg" | grep -qiE '\[skip ci\]|\[ci skip\]' && no_bump "[skip ci] marker present"

if printf '%s\n' "$subject" | grep -qE '^[a-z]+(\([^)]+\))?!:' \
   || printf '%s\n' "$body" | grep -qE '^BREAKING CHANGE:'; then
  level=major
else
  type=$(printf '%s\n' "$subject" | grep -oE '^[a-z]+' || true)
  case "$type" in
    feat)                                level=minor ;;
    fix)                                 level=patch ;;
    ci|test|docs|chore)                  level=none  ;;
    *)                                   level=patch ;;
  esac
fi
[[ "$level" == none ]] && no_bump "non-shipping commit type (${type:-<empty>})"
log "bump level: $level"

bump() { # <version> <level>
  local a b c; IFS=. read -r a b c <<<"$1"
  case "$2" in
    major) echo "$((a + 1)).0.0" ;;
    minor) echo "${a}.$((b + 1)).0" ;;
    patch) echo "${a}.${b}.$((c + 1))" ;;
  esac
}

next_for() { # <pkg-json> <npm-name>
  local local_v pub_v base
  local_v=$(jq -r .version "$1")
  pub_v=$(npm view "$2" version 2>/dev/null || echo "0.0.0")
  base=$(printf '%s\n%s\n' "$local_v" "$pub_v" | sort -V | tail -1)
  bump "$base" "$level"
}

patch_version() { # <pkg-json> <old> <new>
  local esc=${2//./\\.}
  sed -i -E "s|^(\\s*\"version\"\\s*:\\s*\")${esc}(\")|\\1${3}\\2|" "$1"
  grep -qE "^\\s*\"version\"\\s*:\\s*\"${3//./\\.}\"" "$1" \
    || { echo "[bump] failed to patch version in $1" >&2; exit 1; }
}

pin_dep() { # <pkg-json> <dep-name> <dep-new-version>
  sed -i -E "s|(\"${2}\"\\s*:\\s*\")[^\"]+(\")|\\1${3}\\2|" "$1"
  grep -qF "\"${2}\": \"${3}\"" "$1" \
    || { echo "[bump] failed to pin ${2}@${3} in $1" >&2; exit 1; }
}

# Pass 1: compute + apply the version bump for every managed package. Remember new versions.
declare -A NEWV
summary=""
files=(package-lock.json)
for entry in "${MANAGED[@]}"; do
  IFS='|' read -r name path _pin <<<"$entry"
  old=$(jq -r .version "$path"); new=$(next_for "$path" "$name")
  log "$name: $old -> $new"
  patch_version "$path" "$old" "$new"
  NEWV["$name"]="$new"
  files+=("$path")
  short=${name#@ours.network/}
  summary+="${short} v${new}, "
done

# Pass 2: PIN-SYNC — each plugin depends on the exact internal version it ships with.
for entry in "${MANAGED[@]}"; do
  IFS='|' read -r name path pin <<<"$entry"
  [[ -z "$pin" ]] && continue
  pin_dep "$path" "$pin" "${NEWV[$pin]}"
  log "pinned ${pin}@${NEWV[$pin]} in ${name}"
done

npm install --package-lock-only --ignore-scripts >/dev/null

git config user.name  "ours-ci-version-bump[bot]"
git config user.email "ours-ci-version-bump[bot]@users.noreply.github.com"
git add "${files[@]}"
git diff --cached --quiet && no_bump "no changes after patch"

git commit -m "chore(release): ${summary%, } [skip ci]

Triggered by $(git rev-parse --short HEAD): $(printf '%s' "$subject" | head -c 200)"
git push origin "HEAD:${GITHUB_REF_NAME:-main}"

emit "bumped=true"
emit "new-sha=$(git rev-parse HEAD)"
emit "core-version=${NEWV[@ours.network/mcp]}"
emit "plugin-version=${NEWV[@ours.network/claude-code]}"
emit "hermes-version=${NEWV[@ours.network/hermes]}"
emit "openclaw-version=${NEWV[@ours.network/openclaw]}"
emit "codex-version=${NEWV[@ours.network/codex]}"
