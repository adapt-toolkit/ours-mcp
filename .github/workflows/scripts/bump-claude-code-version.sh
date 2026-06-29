#!/usr/bin/env bash
#
# Auto-bumps the Claude Code plugin package @ours.network/claude-code
# (packages/claude-code) and commits the bump back to main with [skip ci].
# Runs as the `release-claude-code` job of publish.yml on pushes to main,
# AFTER release-core (so a same-push core release is already published).
#
# PIN-SYNC: before bumping, this sets the plugin's exact @ours.network/mcp
# dependency to the just-published core version (env CORE_VERSION, set by the
# release-core job) or, if core did not publish in this run, to the latest
# version published on npm. So the pin is never stale at plugin-publish time and
# the plugin never references an unpublished core.
#
# Bumps TWO version files in lockstep (they must agree — plugin.json's version
# is the Claude Code plugin cache key):
#   packages/claude-code/package.json                 ← npm package version
#   packages/claude-code/.claude-plugin/plugin.json   ← Claude Code plugin version
#
# Bump level + version-line rules match bump-core-version.sh. claude-code is a
# brand-new package, so on first run npm has no published version and the base
# is the local field. dist/ is built fresh by prepublishOnly at publish time.

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

PKG_NAME="@ours.network/claude-code"
CORE_NAME="@ours.network/mcp"
PKG_JSON="packages/claude-code/package.json"
PLUGIN_JSON="packages/claude-code/.claude-plugin/plugin.json"

emit() { [[ -n "${GITHUB_OUTPUT:-}" ]] && printf '%s\n' "$1" >> "$GITHUB_OUTPUT" || true; }
log()  { printf '[bump-claude-code] %s\n' "$*"; }
no_bump() { log "no bump: $1"; emit "bumped=false"; exit 0; }

# ----- commit message → bump level ------------------------------------------
msg=$(git log -1 --pretty=%B HEAD)
subject=$(printf '%s\n' "$msg" | head -n1)
body=$(printf '%s\n' "$msg" | tail -n +2)
log "head subject: $subject"

if printf '%s\n' "$msg" | grep -qiE '\[skip ci\]|\[ci skip\]'; then
  no_bump "[skip ci] marker present"
fi
if printf '%s\n' "$subject" | grep -qE '^[a-z]+(\([^)]+\))?!:' \
   || printf '%s\n' "$body" | grep -qE '^BREAKING CHANGE:'; then
  level=major
else
  type=$(printf '%s\n' "$subject" | grep -oE '^[a-z]+' || true)
  case "$type" in
    feat)                                level=minor ;;
    fix)                                 level=patch ;;
    ci|test|docs|chore)                  level=none  ;;
    refactor|perf|style|build|revert|"") level=patch ;;
    *)                                   level=patch ;;
  esac
fi
[[ "$level" == none ]] && no_bump "non-shipping commit type (${type:-<empty>})"
log "bump level: $level"

# ----- PIN-SYNC: point the core dependency at the published core ------------
core_ver="${CORE_VERSION:-}"
if [[ -z "$core_ver" ]]; then
  core_ver=$(npm view "$CORE_NAME" version 2>/dev/null || true)
fi
if [[ -z "$core_ver" ]]; then
  log "WARNING: could not resolve a published ${CORE_NAME} version; leaving the existing pin"
else
  node -e "const f='${PKG_JSON}';const j=require('./'+f);j.dependencies=j.dependencies||{};j.dependencies['${CORE_NAME}']='${core_ver}';require('fs').writeFileSync(f,JSON.stringify(j,null,2)+'\n')"
  log "pinned ${CORE_NAME} -> ${core_ver}"
fi

# ----- compute new version from max(local, published) -----------------------
semver_max() { printf '%s\n%s\n' "$1" "$2" | grep -vE '^$' | sort -V | tail -n1; }
bump() {
  local v=$1 L=$2 major minor patch
  IFS=. read -r major minor patch <<<"$v"
  case "$L" in
    major) printf '%d.0.0\n' "$((major+1))" ;;
    minor) printf '%d.%d.0\n' "$major" "$((minor+1))" ;;
    patch) printf '%d.%d.%d\n' "$major" "$minor" "$((patch+1))" ;;
  esac
}

local_v=$(node -p "require('./${PKG_JSON}').version")
published_v=$(npm view "$PKG_NAME" version 2>/dev/null || true)
base=$(semver_max "$local_v" "$published_v")
new=$(bump "$base" "$level")
log "${PKG_NAME}: local=${local_v} published=${published_v:-<none>} base=${base} -> ${new}"

# ----- patch BOTH version fields in lockstep --------------------------------
set_version() {
  local f=$1
  node -e "const p='${f}';const j=require('./'+p);j.version='${new}';require('fs').writeFileSync(p,JSON.stringify(j,null,2)+'\n')"
  grep -qE "\"version\": \"${new}\"" "$f" || { echo "[bump-claude-code] failed to set version in $f" >&2; exit 1; }
}
set_version "$PKG_JSON"
set_version "$PLUGIN_JSON"

npm install --package-lock-only --ignore-scripts >/dev/null

# ----- commit + push (rebase-retry on concurrent main movement) -------------
git config user.name  "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add "$PKG_JSON" "$PLUGIN_JSON" package-lock.json
if git diff --cached --quiet; then no_bump "no changes after patch"; fi

src_sha=$(git rev-parse --short HEAD)
git commit -m "chore(release): bump ${PKG_NAME} to ${new} [skip ci]

Triggered by ${src_sha}: $(printf '%s' "$subject" | head -c 160)"

branch="${GITHUB_REF_NAME:-main}"
attempts=0
until git push origin "HEAD:${branch}"; do
  attempts=$((attempts+1)); [[ $attempts -ge 5 ]] && { log "push failed ${attempts}x"; exit 1; }
  log "push rejected; rebasing onto origin/${branch} (attempt ${attempts})"
  git fetch origin "$branch" --quiet
  if ! git rebase "origin/${branch}"; then
    git checkout "origin/${branch}" -- package-lock.json
    npm install --package-lock-only --ignore-scripts >/dev/null
    git add "$PKG_JSON" "$PLUGIN_JSON" package-lock.json
    GIT_EDITOR=true git rebase --continue
  fi
done

log "published version will be ${new}"
emit "bumped=true"
emit "version=${new}"
