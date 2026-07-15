#!/usr/bin/env bash
#
# LOCKSTEP release versioning: computes ONE next version for the whole @ours.network suite and
# sets it on EVERY managed package.json AND every native plugin manifest,
# re-pins each plugin's exact internal dependency to that same version, refreshes the lockfile,
# and pushes — one [skip ci] commit. The single bump is applied to the MAX of every package's
# max(local, npm-published) version, so the unified version is always publishable for all of
# them (npm never sees a version twice) and packages can never drift apart again.
#
# Managed packages (publish order = dependency order):
#   @ours.network/mcp        packages/core         (no internal deps)
#   @ours.network/claude-code packages/claude-code (pins @ours.network/mcp)
#   @ours.network/hermes     packages/hermes       (no internal deps)
#   @ours.network/codex      packages/codex        (pins @ours.network/mcp)
#   @ours.network/install    packages/installer    (self-contained — no internal deps)
# (Claude Code and Codex plugin manifests are not npm packages, but their user-visible versions
# stay at the suite version.)
#
# Bump level comes from the HEAD commit subject (Conventional Commits):
#   feat: minor · fix: patch · !/BREAKING: major
#   refactor/perf/style/build/revert/other: patch · ci/test/docs/chore: none
#
# OURS_BUMP_DRY_RUN=1: compute + patch the files in the working tree, print the resulting
# versions/pins, and exit WITHOUT committing or pushing (verification; caller reverts).

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# name|json-path|pin-dep (pin-dep empty = none). Order matters: publish/bump in this order.
MANAGED=(
  "@ours.network/mcp|packages/core/package.json|"
  "@ours.network/claude-code|packages/claude-code/package.json|@ours.network/mcp"
  "@ours.network/hermes|packages/hermes/package.json|"
  "@ours.network/codex|packages/codex/package.json|@ours.network/mcp"
  "@ours.network/install|packages/installer/package.json|"
)

# Every native plugin manifest in the repo — bumped to the same suite version.
PLUGIN_MANIFESTS=()
while IFS= read -r f; do PLUGIN_MANIFESTS+=("$f"); done \
  < <(git ls-files 'packages/*/.claude-plugin/plugin.json' 'packages/*/.codex-plugin/plugin.json')

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

# Pass 0: ONE suite version — bump from the MAX of every managed package's max(local, published),
# so the result is strictly greater than anything npm has for ANY of them (all publishable).
base="0.0.0"
for entry in "${MANAGED[@]}"; do
  IFS='|' read -r name path _pin <<<"$entry"
  local_v=$(jq -r .version "$path")
  pub_v=$(npm view "$name" version 2>/dev/null || echo "0.0.0")
  base=$(printf '%s\n%s\n%s\n' "$base" "$local_v" "$pub_v" | sort -V | tail -1)
  log "$name: local $local_v, published $pub_v"
done
UNIFIED=$(bump "$base" "$level")
log "suite version: $base -> $UNIFIED (single $level bump over the max across all packages)"

# Pass 1: apply the suite version to every managed package.json + every plugin manifest.
declare -A NEWV
files=(package-lock.json)
for entry in "${MANAGED[@]}"; do
  IFS='|' read -r name path _pin <<<"$entry"
  old=$(jq -r .version "$path")
  log "$name: $old -> $UNIFIED"
  patch_version "$path" "$old" "$UNIFIED"
  NEWV["$name"]="$UNIFIED"
  files+=("$path")
done
for f in "${PLUGIN_MANIFESTS[@]}"; do
  old=$(jq -r .version "$f")
  log "$f: $old -> $UNIFIED"
  patch_version "$f" "$old" "$UNIFIED"
  files+=("$f")
done
summary="v${UNIFIED} lockstep (mcp, claude-code, hermes, codex, install + plugin manifests)"

# Pass 2: PIN-SYNC — each plugin depends on the exact internal version it ships with.
for entry in "${MANAGED[@]}"; do
  IFS='|' read -r name path pin <<<"$entry"
  [[ -z "$pin" ]] && continue
  pin_dep "$path" "$pin" "${NEWV[$pin]}"
  log "pinned ${pin}@${NEWV[$pin]} in ${name}"
done

npm install --package-lock-only --ignore-scripts >/dev/null

# Load-bearing publish invariant: do not push a release commit with mismatched package,
# native-manifest, or internal-dependency versions.
for entry in "${MANAGED[@]}"; do
  IFS='|' read -r name path pin <<<"$entry"
  [[ "$(jq -r .version "$path")" == "$UNIFIED" ]] \
    || { echo "[bump] invariant failed: $path is not v$UNIFIED" >&2; exit 1; }
  if [[ -n "$pin" ]]; then
    [[ "$(jq -r ".dependencies[\"$pin\"]" "$path")" == "$UNIFIED" ]] \
      || { echo "[bump] invariant failed: $name does not pin $pin@$UNIFIED" >&2; exit 1; }
  fi
done
for f in "${PLUGIN_MANIFESTS[@]}"; do
  [[ "$(jq -r .version "$f")" == "$UNIFIED" ]] \
    || { echo "[bump] invariant failed: $f is not v$UNIFIED" >&2; exit 1; }
done

if [[ -n "${OURS_BUMP_DRY_RUN:-}" ]]; then
  log "DRY RUN — no commit/push. Resulting versions:"
  for entry in "${MANAGED[@]}"; do
    IFS='|' read -r name path pin <<<"$entry"
    pin_now=""
    [[ -n "$pin" ]] && pin_now="  (pins ${pin}@$(jq -r ".dependencies[\"$pin\"]" "$path"))"
    log "  $path -> $(jq -r .version "$path")${pin_now}"
  done
  for f in "${PLUGIN_MANIFESTS[@]}"; do
    log "  $f -> $(jq -r .version "$f")"
  done
  exit 0
fi

git config user.name  "ours-ci-version-bump[bot]"
git config user.email "ours-ci-version-bump[bot]@users.noreply.github.com"
git add "${files[@]}"
git diff --cached --quiet && no_bump "no changes after patch"

git commit -m "chore(release): ${summary} [skip ci]

Triggered by $(git rev-parse --short HEAD): $(printf '%s' "$subject" | head -c 200)"
git push origin "HEAD:${GITHUB_REF_NAME:-main}"

emit "bumped=true"
emit "new-sha=$(git rev-parse HEAD)"
emit "unified-version=${UNIFIED}"
emit "core-version=${NEWV[@ours.network/mcp]}"
emit "plugin-version=${NEWV[@ours.network/claude-code]}"
emit "hermes-version=${NEWV[@ours.network/hermes]}"
emit "codex-version=${NEWV[@ours.network/codex]}"
emit "install-version=${NEWV[@ours.network/install]}"
