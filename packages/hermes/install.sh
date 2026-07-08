#!/usr/bin/env bash
# Install the ours.network plugin into Hermes:
#   1. ensure the ours daemon (@ours.network/mcp) is installed + running
#   2. install the ours + writing-agent-bios skills into ~/.hermes/skills/
#   3. write the `ours` MCP server + the `ours-wake` webhook route into
#      ~/.hermes/config.yaml (idempotent, never corrupts existing YAML)
#   4. start the per-identity reactivity watcher (connector) sharing one HMAC secret
#
# Idempotent: safe to re-run. Test/CI knobs (all optional):
#   HERMES_DIR                 config+skills root         (default ~/.hermes)
#   CONNECTOR_DIR              path to @ours.network/connector (auto-detected)
#   CONNECTOR_IDENTITIES       space-separated identities to watch
#   OURS_WAKE_SECRET           shared HMAC secret        (generated if unset)
#   OURS_WEBHOOK_PORT          webhook port              (default 8644)
#   OURS_INSTALL_SKIP_DAEMON=1 skip daemon install/start
#   OURS_INSTALL_SKIP_WATCHER=1 skip starting the watcher
set -euo pipefail

SELFDIR="$(cd "$(dirname "$0")" && pwd)"
HERMES_DIR="${HERMES_DIR:-$HOME/.hermes}"
HERMES_CONFIG="$HERMES_DIR/config.yaml"
SKILLS_DEST="$HERMES_DIR/skills/communication"
ENV_FILE="$HERMES_DIR/ours-connector.env"
OURS_WEBHOOK_PORT="${OURS_WEBHOOK_PORT:-8644}"

say(){ printf 'ours-install: %s\n' "$1"; }

# --- locate the connector (monorepo sibling, installed dep, or explicit) ---
find_connector(){
  local c
  for c in "${CONNECTOR_DIR:-}" "$SELFDIR/../connector" \
           "$SELFDIR/node_modules/@ours.network/connector" \
           "$HERMES_DIR/../@ours.network/connector"; do
    [ -n "$c" ] && [ -f "$c/connector-watch.sh" ] && { echo "$c"; return 0; }
  done
  return 1
}

# --- 1) daemon ---
if [ "${OURS_INSTALL_SKIP_DAEMON:-}" != "1" ]; then
  if ! command -v ours-mcp >/dev/null 2>&1; then
    say "installing @ours.network/mcp globally (npm i -g)…"
    npm i -g @ours.network/mcp
  fi
  if ! ours-mcp status >/dev/null 2>&1; then say "starting the ours daemon…"; ours-mcp start || true; fi
  say "daemon: $(command -v ours-mcp)"
else
  say "skipping daemon step (OURS_INSTALL_SKIP_DAEMON=1)"
fi

# --- 2) skills ---
mkdir -p "$SKILLS_DEST"
for s in ours writing-agent-bios; do
  rm -rf "${SKILLS_DEST:?}/$s"
  cp -R "$SELFDIR/skills/$s" "$SKILLS_DEST/$s"
  say "installed skill: $SKILLS_DEST/$s"
done

# --- 3) shared secret (persist so route + watcher always match) ---
if [ -z "${OURS_WAKE_SECRET:-}" ] && [ -f "$ENV_FILE" ]; then
  # Reuse ONLY the persisted secret so the route and the watcher never drift apart across
  # re-runs. Extract it in a SUBSHELL so sourcing the env file cannot clobber the current
  # environment — the file also `export`s CONNECTOR_IDENTITIES (from the prior run), and a
  # naive `. "$ENV_FILE"` would overwrite a re-run's CLI-provided --identities, silently
  # no-op'ing the watcher. The env file records the secret as CONNECTOR_HMAC_SECRET.
  OURS_WAKE_SECRET="$(. "$ENV_FILE" >/dev/null 2>&1; printf '%s' "${CONNECTOR_HMAC_SECRET:-}")"
fi
if [ -z "${OURS_WAKE_SECRET:-}" ] || [ "${OURS_WAKE_SECRET:-}" = "CHANGE_ME_local_webhook_hmac" ]; then
  OURS_WAKE_SECRET="$(openssl rand -hex 32)"
  say "generated a new shared HMAC secret"
fi
mkdir -p "$HERMES_DIR"
umask 077
cat > "$ENV_FILE" <<EOF
# ours.network connector env (managed by install.sh). Sourced to start the watcher.
export CONNECTOR_HMAC_SECRET="$OURS_WAKE_SECRET"
export CONNECTOR_WEBHOOK_URL="http://localhost:$OURS_WEBHOOK_PORT/webhooks/ours-wake"
export CONNECTOR_EVENT="ours_wake"
export CONNECTOR_IDENTITIES="${CONNECTOR_IDENTITIES:-}"
EOF
say "wrote connector env: $ENV_FILE"

# --- 4) config.yaml (idempotent, safe merge) ---
OURS_WAKE_SECRET="$OURS_WAKE_SECRET" CONNECTOR_IDENTITIES="${CONNECTOR_IDENTITIES:-}" \
  OURS_WEBHOOK_PORT="$OURS_WEBHOOK_PORT" HERMES_CONFIG="$HERMES_CONFIG" \
  node "$SELFDIR/bin/hermes-config-install.mjs" || {
    rc=$?; [ "$rc" = "3" ] && say "config needs a manual merge (see block above)"; [ "$rc" = "3" ] || exit "$rc";
  }

# --- 5) watcher ---
if [ "${OURS_INSTALL_SKIP_WATCHER:-}" = "1" ]; then
  say "skipping watcher start (OURS_INSTALL_SKIP_WATCHER=1)"
elif [ -z "${CONNECTOR_IDENTITIES:-}" ]; then
  say "no CONNECTOR_IDENTITIES set — not starting the watcher. Start it later with:"
  say "  CONNECTOR_IDENTITIES=\"Agent1 Agent2\" bash $SELFDIR/install.sh"
elif CONN="$(find_connector)"; then
  if pgrep -f "connector-watch.sh" >/dev/null 2>&1; then
    say "a connector watcher is already running — leaving it (restart it to pick up new identities)"
  else
    say "starting the reactivity watcher for: $CONNECTOR_IDENTITIES"
    ( set -a; . "$ENV_FILE"; set +a; nohup bash "$CONN/connector-watch.sh" >"$HERMES_DIR/ours-connector.log" 2>&1 & )
    say "watcher started (logs: $HERMES_DIR/ours-connector.log)"
  fi
else
  say "could not locate @ours.network/connector — set CONNECTOR_DIR and re-run to start the watcher"
fi

say "done. Run /reload-mcp in Hermes to load the mcp_ours_* tools."
if [ -z "${CONNECTOR_IDENTITIES:-}" ]; then
  say "tip: to wake an agent on new mail, re-run with its identities:"
  say "     ours-hermes-install --identities \"Agent1 Agent2\""
fi
