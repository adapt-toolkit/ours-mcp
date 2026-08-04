#!/usr/bin/env bash
# Driver for packages/core/test/temp-remove-me-mufl.test.mjs: real local broker,
# one daemon, a permanent anchor + a temporary identity. Proves the core 0.13
# remove-me notice actually lands on close, and that a broker outage never
# blocks local cleanup. Needs the built dist/ (npm run build) and the compiled
# .muflo (compile-mufl.sh, run below).
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
broker_log="$(mktemp)"
broker_pid=""
cleanup() {
  if [ -n "$broker_pid" ]; then kill "$broker_pid" 2>/dev/null || true; fi
  rm -f "$broker_log"
}
trap cleanup EXIT

"$repo_root/scripts/compile-mufl.sh"

port="${TEMP_REMOVE_TEST_PORT:-19876}"
node "$repo_root/scripts/dev-broker.mjs" --host 127.0.0.1 --port "$port" --test_mode >"$broker_log" 2>&1 &
broker_pid="$!"
sleep 2
if ! kill -0 "$broker_pid" 2>/dev/null; then
  cat "$broker_log"
  exit 1
fi

BROKER_URL="ws://127.0.0.1:$port" \
BROKER_PID="$broker_pid" \
  node "$repo_root/packages/core/test/temp-remove-me-mufl.test.mjs"
