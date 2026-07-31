#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
core_dir="$repo_root/packages/core/mufl_code/core"
toolkit="$repo_root/node_modules/@adapt-toolkit/mufl"
compiler="$toolkit/prebuilds/linux-x64/mufl-compile"
peer_build="$(mktemp -d)"
broker_log="$peer_build/broker.log"
broker_pid=""
cleanup() {
  if [ -n "$broker_pid" ]; then kill "$broker_pid" 2>/dev/null || true; fi
  rm -rf "$peer_build"
}
trap cleanup EXIT

"$repo_root/scripts/compile-mufl.sh"

mkdir "$peer_build/core"
cp "$core_dir"/*.mm "$core_dir/config.mufl" "$peer_build/core/"
cp "$core_dir/tests/test_actor.mu" "$core_dir/tests/protocol_container.mm" "$peer_build/"
cp "$repo_root/packages/core/mufl_code/config.mufl" "$peer_build/config.mufl"
# The current SDK requires broker registration_proof at packet boot. The core's
# compatibility harness applies this same test-only load to historical actors.
sed -i '0,/loads libraries/s//loads libraries\n    registration_proof,/' "$peer_build/test_actor.mu"

echo "compiling qa-probe peer fixture from source …"
(
  cd "$peer_build"
  MUFL_STDLIB_PATH="$toolkit/mufl_stdlib" \
    "$compiler" -mp "$toolkit/meta" -mp "$toolkit/transactions" test_actor.mu >/dev/null
)

port="${UNIQ_TEST_PORT:-19876}"
node "$repo_root/scripts/dev-broker.mjs" --host 127.0.0.1 --port "$port" --test_mode >"$broker_log" 2>&1 &
broker_pid="$!"
sleep 2
if ! kill -0 "$broker_pid" 2>/dev/null; then
  cat "$broker_log"
  exit 1
fi

BROKER_URL="ws://127.0.0.1:$port" \
PEER_UNIT_DIR="$peer_build" \
  node "$repo_root/packages/core/test/contact-uniqueness-mufl.test.mjs"
