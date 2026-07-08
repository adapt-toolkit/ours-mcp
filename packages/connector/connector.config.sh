# ours.network connector — config (generalized from the Hermes a2adapt bridge; MULTI-IDENTITY).
# Source before running connector-watch.sh; the .mjs helpers read the same vars from env.
# Every value is overridable by the environment; defaults target ours-mcp @ours.network/mcp 0.3.x.

# --- MCP CLI ---
export CONNECTOR_CLI="${CONNECTOR_CLI:-ours-mcp}"                 # MCP CLI name (ours-mcp; was a2adapt-mcp)

# --- identities (MULTI: one per subagent in the harness) ---
# Space-separated list. Each subagent binds its OWN identity + is watched/woken/drained independently.
# Back-compat: a single CONNECTOR_IDENTITY still works.
export CONNECTOR_IDENTITIES="${CONNECTOR_IDENTITIES:-${CONNECTOR_IDENTITY:-Peer}}"
# Per-identity proxy session id = "<prefix>-<identity>" (so each identity's drain/backstop coexists
# with its own subagent, never colliding across identities). The harness's subagent for <identity>
# should bind using the same scheme so reads coexist.
export CONNECTOR_SESSION_PREFIX="${CONNECTOR_SESSION_PREFIX:-ours-connector}"

# --- ours daemon (ONE shared daemon serves all N identities) ---
export OURS_PORT="${OURS_PORT:-3050}"                            # daemon port (was A2ADAPT_PORT 3031)
export OURS_STATE_DIR="${OURS_STATE_DIR:-$HOME/.ours}"           # daemon state dir (was A2ADAPT_STATE_DIR)
export OURS_BROKER_URL="${OURS_BROKER_URL:-wss://broker1.ours.network}"  # broker (0.3.x default already)

# --- webhook (wake carries the identity; gateway routes to the right subagent) ---
export CONNECTOR_WEBHOOK_URL="${CONNECTOR_WEBHOOK_URL:-http://localhost:8644/webhooks/ours-wake}"
export CONNECTOR_HMAC_SECRET="${CONNECTOR_HMAC_SECRET:-CHANGE_ME_local_webhook_hmac}"  # HMAC-SHA256 shared secret
export CONNECTOR_EVENT="${CONNECTOR_EVENT:-ours_wake}"           # event name; sent as X-GitHub-Event header + body event_type/event, alongside {"identity":"<id>"}
export CONNECTOR_WEBHOOK_OK_CODE="${CONNECTOR_WEBHOOK_OK_CODE:-200}"  # expected success HTTP code (Hermes webhook adapter acks 200; override if your gateway differs)

# --- hardening knobs ---
export CONNECTOR_BACKSTOP_SECS="${CONNECTOR_BACKSTOP_SECS:-420}" # per-identity missed-wake backstop poll interval (gateway-side)
export CONNECTOR_POKE_BACKOFF="${CONNECTOR_POKE_BACKOFF:-0 2 5 10}"  # retry delays (secs) for a poke
