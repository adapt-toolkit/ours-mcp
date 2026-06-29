#!/bin/bash
# Compile the ours messenger packet (packages/core/mufl_code/actor.mu) into a
# content-hashed .muflo, and drop it into packages/core/mufl_code/ (and, if present,
# packages/core/dist/mufl_code/). The MCP server loads whatever single .muflo it
# finds there at runtime (see locateUnit() in packages/core/src/index.ts), so the
# old one is removed first.
#
# Requires a built ADAPT toolkit checkout providing `mufl-compile` plus the
# mufl_stdlib / meta / transactions trees. Point ADAPT_TOOLKIT at it:
#
#   ADAPT_TOOLKIT=/path/to/adapt scripts/compile-mufl.sh
#
# To (re)build mufl-compile inside the toolkit: `python3 build.py --compiler_release`.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
mufl_src_dir="$repo_root/packages/core/mufl_code"
dist_dir="$repo_root/packages/core/dist/mufl_code"

toolkit="${ADAPT_TOOLKIT:-/home/shakhvit/work/adapt/adapt-toolkit}"
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

if [ ! -f "$mufl_src_dir/core/config.mufl" ]; then
  echo "error: shared mufl core missing at '$mufl_src_dir/core' — run 'git submodule update --init'." >&2
  exit 1
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
cp "$mufl_src_dir/actor.mu" "$mufl_src_dir/config.mufl" "$tmp_dir/"
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
