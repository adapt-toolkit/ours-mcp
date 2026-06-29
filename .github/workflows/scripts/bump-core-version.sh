#!/usr/bin/env bash
#
# Auto-bumps the agent-agnostic server package @ours.network/mcp
# (packages/core) and commits the bump back to main with [skip ci]. Designed to
# run as the `release-core` job of publish.yml on pushes to main.
#
# Bump level is derived from the HEAD commit subject via Conventional Commits:
#   feat:                              minor
#   fix:                               patch
#   feat!: / fix!: / BREAKING CHANGE:  major
#   refactor:/perf:/style:/build:/...  patch (safe default)
#   ci: / test: / docs: / chore:       none  (no bump)
#   [skip ci] / [ci skip]              none
#
# The new version is computed from max(local package.json, latest published on
# npm) so a release always lands ABOVE the published latest even if the local
# version field lags (e.g. local 0.13.1 while npm already has 0.13.2).
#
# dist/ is NOT committed (it is gitignored and built fresh by prepublishOnly at
# publish time), so this script only touches the version field + lockfile.

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

PKG_NAME="@ours.network/mcp"
PKG_JSON="packages/core/package.json"

emit() { [[ -n "${GITHUB_OUTPUT:-}" ]] && printf '%s\n' "$1" >> "$GITHUB_OUTPUT" || true; }
log()  { printf '[bump-core] %s\n' "$*"; }
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

# ----- patch the version field (anchored to top-level "version") ------------
esc=${base//./\\.}
sed -i -E "s|^(\\s*\"version\"\\s*:\\s*\")${esc}(\")|\\1${new}\\2|" "$PKG_JSON"
if ! grep -qE "^\\s*\"version\"\\s*:\\s*\"${new}\"" "$PKG_JSON"; then
  # base came from npm, not the local file — set the local field directly.
  node -e "const f='${PKG_JSON}';const j=require('./'+f);j.version='${new}';require('fs').writeFileSync(f,JSON.stringify(j,null,2)+'\n')"
fi
grep -qE "\"version\": \"${new}\"" "$PKG_JSON" || { echo "[bump-core] failed to set version in $PKG_JSON" >&2; exit 1; }

npm install --package-lock-only --ignore-scripts >/dev/null

# ----- commit + push (rebase-retry on concurrent main movement) -------------
git config user.name  "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add "$PKG_JSON" package-lock.json
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
    git add "$PKG_JSON" package-lock.json
    GIT_EDITOR=true git rebase --continue
  fi
done

log "published version will be ${new}"
emit "bumped=true"
emit "version=${new}"
