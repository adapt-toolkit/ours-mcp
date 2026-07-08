#!/usr/bin/env bash
# Install the ours.network plugin into OpenClaw:
#   1. ensure the ours daemon (@ours.network/mcp) is installed + running
#   2. install the ours + writing-agent-bios skills into ~/.openclaw/skills/
#   3. write the `ours` MCP server (mcp.servers.ours) + a per-identity webhook route
#      (plugins.entries.webhooks.config.routes.*) into ~/.openclaw/openclaw.json
#      (idempotent; never clobbers an existing JSON5 config)
#   4. start the per-identity reactivity watcher (connector), which pokes each
#      OpenClaw route with a STATIC bearer token (CONNECTOR_AUTH_HEADER)
#
# Idempotent: safe to re-run. Test/CI knobs (all optional):
#   OPENCLAW_DIR               config+skills root         (default ~/.openclaw)
#   CONNECTOR_DIR              path to @ours.network/connector (auto-detected)
#   CONNECTOR_IDENTITIES       space-separated identities to watch
#   OURS_WAKE_SECRET           shared static bearer token (generated if unset)
#   OURS_WEBHOOK_PORT          OpenClaw gateway port      (default 18789)
#   OURS_INSTALL_SKIP_DAEMON=1 skip daemon install/start
#   OURS_INSTALL_SKIP_WATCHER=1 skip starting the watcher
set -euo pipefail

SELFDIR="$(cd "$(dirname "$0")" && pwd)"
OPENCLAW_DIR="${OPENCLAW_DIR:-$HOME/.openclaw}"
OPENCLAW_CONFIG="$OPENCLAW_DIR/openclaw.json"
SKILLS_DEST="$OPENCLAW_DIR/skills"
ENV_FILE="$OPENCLAW_DIR/ours-connector.env"
# OpenClaw's gateway default port is 18789 (resolution: --port → OPENCLAW_GATEWAY_PORT →
# gateway.port → 18789, per docs.openclaw.ai). OURS_WEBHOOK_PORT overrides it here.
OURS_WEBHOOK_PORT="${OURS_WEBHOOK_PORT:-18789}"

say(){ printf 'ours-install: %s\n' "$1"; }

# --- locate the connector (monorepo sibling, installed dep, or explicit) ---
find_connector(){
  local c
  for c in "${CONNECTOR_DIR:-}" "$SELFDIR/../connector" \
           "$SELFDIR/node_modules/@ours.network/connector" \
           "$OPENCLAW_DIR/../@ours.network/connector"; do
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

# --- 3) shared bearer token (persist so routes + watcher always match) ---
# OpenClaw's webhooks plugin authenticates a poke with a STATIC token (bearer), not HMAC.
# We generate ONE token and share it into both the openclaw.json routes' env secret and the
# connector's CONNECTOR_AUTH_HEADER. (The connector still sends its HMAC header too; OpenClaw
# ignores it.)
if [ -z "${OURS_WAKE_SECRET:-}" ] && [ -f "$ENV_FILE" ]; then
  # Reuse ONLY the persisted token so the routes and the watcher never drift apart across
  # re-runs. Extract it in a SUBSHELL so sourcing the env file cannot clobber the current
  # environment — the file also `export`s OURS_WEBHOOK_PORT (from the prior run), and a naive
  # `. "$ENV_FILE"` would overwrite a re-run's CLI-provided --port. The file records the token
  # as OURS_WAKE_SECRET.
  OURS_WAKE_SECRET="$(. "$ENV_FILE" >/dev/null 2>&1; printf '%s' "${OURS_WAKE_SECRET:-}")"
fi
if [ -z "${OURS_WAKE_SECRET:-}" ] || [ "${OURS_WAKE_SECRET:-}" = "CHANGE_ME_local_webhook_hmac" ]; then
  OURS_WAKE_SECRET="$(openssl rand -hex 32)"
  say "generated a new shared bearer token"
fi
# slugify an identity into an OpenClaw route name (same rule the config planner uses).
slugify(){ printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g'; }
# OpenClaw routes a webhook by PATH → a fixed sessionKey, so each identity has its OWN route
# (/plugins/webhooks/ours-wake-<slug>) bound to its own agent session. The connector pokes ONE
# CONNECTOR_WEBHOOK_URL per watcher, so we run ONE watcher PER identity (step 5), each pointed at
# that identity's route. The ENV_FILE holds only the shared bits; per-identity URL/identity are
# set at launch. (All routes share ONE bearer token — OpenClaw's secret ref is per-route but the
# value is the same, so a single token authenticates every poke.)
mkdir -p "$OPENCLAW_DIR"
umask 077
cat > "$ENV_FILE" <<EOF
# ours.network connector env (managed by install.sh). Sourced to start the per-identity watchers.
# OURS_WAKE_SECRET is the STATIC bearer token OpenClaw's webhooks plugin checks; the routes'
# env secret and the connector's Authorization header must carry this same value. Each watcher
# additionally sets CONNECTOR_IDENTITIES=<one id> and CONNECTOR_WEBHOOK_URL=<that id's route>.
export OURS_WAKE_SECRET="$OURS_WAKE_SECRET"
export CONNECTOR_AUTH_HEADER="Authorization: Bearer $OURS_WAKE_SECRET"
export CONNECTOR_HMAC_SECRET="$OURS_WAKE_SECRET"
export CONNECTOR_EVENT="ours_wake"
export OURS_WEBHOOK_PORT="$OURS_WEBHOOK_PORT"
EOF
say "wrote connector env: $ENV_FILE"

# --- 3b) put OURS_WAKE_SECRET into the GATEWAY's environment ---------------------------------
# The webhook routes reference the token via secret {source:"env", id:"OURS_WAKE_SECRET"}, which
# resolves from the GATEWAY process's environment — NOT from the watcher env above. OpenClaw's
# gateway loads a global dotenv at ~/.openclaw/.env ($OPENCLAW_STATE_DIR/.env) into its process
# env (per docs.openclaw.ai: "Global .env at ~/.openclaw/.env … recommended for provider keys"),
# so we upsert OURS_WAKE_SECRET there. Without this the route's source:env secret can never
# resolve and every wake would fail auth. Idempotent: replace only our line, keep the user's.
GATEWAY_ENV="$OPENCLAW_DIR/.env"
touch "$GATEWAY_ENV"; chmod 600 "$GATEWAY_ENV"
_gw_tmp="$(mktemp "$OPENCLAW_DIR/.env.XXXXXX")"
grep -v '^OURS_WAKE_SECRET=' "$GATEWAY_ENV" 2>/dev/null > "$_gw_tmp" || true
printf 'OURS_WAKE_SECRET=%s\n' "$OURS_WAKE_SECRET" >> "$_gw_tmp"
mv "$_gw_tmp" "$GATEWAY_ENV"; chmod 600 "$GATEWAY_ENV"
say "set OURS_WAKE_SECRET in the gateway env: $GATEWAY_ENV (loaded on 'openclaw gateway restart')"

# --- 4) openclaw.json (idempotent, safe merge) ---
OURS_WAKE_SECRET="$OURS_WAKE_SECRET" CONNECTOR_IDENTITIES="${CONNECTOR_IDENTITIES:-}" \
  OURS_WEBHOOK_PORT="$OURS_WEBHOOK_PORT" OPENCLAW_CONFIG="$OPENCLAW_CONFIG" \
  node "$SELFDIR/bin/openclaw-config-install.mjs" || {
    rc=$?; [ "$rc" = "3" ] && say "config needs a manual merge (see block above)"; [ "$rc" = "3" ] || exit "$rc";
  }

# --- 5) watcher (ONE per identity → that identity's OpenClaw route) ---
# Each identity gets its own connector-watch.sh, with CONNECTOR_IDENTITIES=<that id> and
# CONNECTOR_WEBHOOK_URL=<that id's route>, sharing the bearer token from ENV_FILE. Idempotent
# via a per-identity pidfile: a live watcher is left alone; a dead/missing one is (re)started.
start_watcher_for(){   # $1 = identity, $2 = connector dir
  local id="$1" conn="$2" slug url pidf
  slug="$(slugify "$id")"
  url="http://localhost:$OURS_WEBHOOK_PORT/plugins/webhooks/ours-wake-$slug"
  pidf="$OPENCLAW_DIR/ours-watch-$slug.pid"
  if [ -f "$pidf" ] && kill -0 "$(cat "$pidf" 2>/dev/null)" 2>/dev/null; then
    say "  watcher for \"$id\" already running (pid $(cat "$pidf"))"; return 0
  fi
  ( set -a; . "$ENV_FILE"; set +a
    export CONNECTOR_IDENTITIES="$id" CONNECTOR_WEBHOOK_URL="$url"
    nohup bash "$conn/connector-watch.sh" >"$OPENCLAW_DIR/ours-connector-$slug.log" 2>&1 &
    echo $! > "$pidf" )
  say "  watcher for \"$id\" → $url (log: ours-connector-$slug.log)"
}

if [ "${OURS_INSTALL_SKIP_WATCHER:-}" = "1" ]; then
  say "skipping watcher start (OURS_INSTALL_SKIP_WATCHER=1)"
elif [ -z "${CONNECTOR_IDENTITIES:-}" ]; then
  say "no CONNECTOR_IDENTITIES set — not starting any watcher. Start it later with:"
  say "  ours-openclaw-install --identities \"Agent1 Agent2\""
elif CONN="$(find_connector)"; then
  say "starting one reactivity watcher per identity: $CONNECTOR_IDENTITIES"
  for id in $CONNECTOR_IDENTITIES; do start_watcher_for "$id" "$CONN"; done
else
  say "could not locate @ours.network/connector — set CONNECTOR_DIR and re-run to start the watchers"
fi

say "done. Run \`openclaw gateway restart\` to load the ours MCP tools + webhook routes."
if [ -z "${CONNECTOR_IDENTITIES:-}" ]; then
  say "tip: to wake an agent on new mail, re-run with its identities:"
  say "     ours-openclaw-install --identities \"Agent1 Agent2\""
fi
