#!/bin/bash
# Compile the ours messenger packet (packages/core/mufl_code/actor.mu) into a
# content-hashed .muflo, and drop it into packages/core/mufl_code/ (and, if present,
# packages/core/dist/mufl_code/). The MCP server loads whatever single .muflo it
# finds there at runtime (see locateUnit() in packages/core/src/index.ts), so the
# old one is removed first.
#
# Needs the mufl toolchain (`mufl-compile` plus the mufl_stdlib / meta /
# transactions trees). Resolution order: an explicit ADAPT_TOOLKIT checkout wins;
# otherwise the npm-installed @adapt-toolkit/mufl package is used:
#
#   ADAPT_TOOLKIT=/path/to/adapt scripts/compile-mufl.sh   # local checkout
#   scripts/compile-mufl.sh                                # npm i already done
#
# To (re)build mufl-compile inside a checkout: `python3 build.py --compiler_release`.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
mufl_src_dir="$repo_root/packages/core/mufl_code"
dist_dir="$repo_root/packages/core/dist/mufl_code"

# Toolkit resolution: explicit checkout wins; else the npm-installed toolchain.
if [ -n "${ADAPT_TOOLKIT:-}" ]; then
  toolkit="$ADAPT_TOOLKIT"
  if [ ! -d "$toolkit" ]; then
    echo "error: ADAPT toolkit not found at '$toolkit' (set ADAPT_TOOLKIT)." >&2
    exit 1
  fi
  platform="$(uname | tr '[:upper:]' '[:lower:]')"
  mufl_compile=""
  for cand in \
    "$toolkit/build/mufl-compile" \
    "$toolkit/build.$platform.release/mufl-compile" \
    "$toolkit/build.$platform.debug/mufl-compile"; do
    if [ -x "$cand" ]; then mufl_compile="$cand"; break; fi
  done
  if [ -z "$mufl_compile" ]; then
    echo "error: mufl-compile not found under '$toolkit' — build it with 'python3 build.py --compiler_release'." >&2
    exit 1
  fi
else
  pkg_root="$(cd "$repo_root" && node -p "path.dirname(require.resolve('@adapt-toolkit/mufl/package.json'))" 2>/dev/null)" \
    || { echo "error: set ADAPT_TOOLKIT or npm-install @adapt-toolkit/mufl." >&2; exit 1; }
  toolkit="$pkg_root"
  mufl_compile="$pkg_root/prebuilds/linux-x64/mufl-compile"
fi
if [ ! -x "$mufl_compile" ]; then
  echo "error: mufl-compile not found/executable at '$mufl_compile'." >&2
  exit 1
fi

if [ ! -f "$mufl_src_dir/core/config.mufl" ]; then
  echo "error: shared mufl core missing at '$mufl_src_dir/core' — run 'git submodule update --init'." >&2
  exit 1
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
cp "$mufl_src_dir/actor.mu" "$mufl_src_dir/config.mufl" "$mufl_src_dir/protocol_container.mm" "$tmp_dir/"
mkdir "$tmp_dir/core"
cp "$mufl_src_dir/core/config.mufl" "$mufl_src_dir/core"/*.mm "$tmp_dir/core/"

echo "compiling actor.mu with $mufl_compile …"
( cd "$tmp_dir" && MUFL_STDLIB_PATH="$toolkit/mufl_stdlib" \
    "$mufl_compile" -mp "$toolkit/meta" -mp "$toolkit/transactions" -d-c actor.mu >/dev/null )

muflo="$(cd "$tmp_dir" && ls *.muflo)"
if [ -z "$muflo" ]; then
  echo "error: compile produced no .muflo" >&2
  exit 1
fi

install_into() {
  local dir="$1"
  [ -d "$dir" ] || return 0
  rm -f "$dir"/*.muflo
  cp "$tmp_dir/$muflo" "$dir/"
  echo "  installed $muflo -> $dir/"
}
install_into "$mufl_src_dir"
install_into "$dist_dir"

echo "done: $muflo"
