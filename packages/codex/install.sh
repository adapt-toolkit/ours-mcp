#!/usr/bin/env bash
# Install the ours.network plugin into the OpenAI Codex CLI:
#   1. ensure the ours daemon (@ours.network/mcp) is installed + running
#   2. install the ours + writing-agent-bios skills into ~/.agents/skills/ (USER scope)
#   3. register the `ours` MCP server ([mcp_servers.ours]) in ~/.codex/config.toml
#      (idempotent — appends the table only if it is not already defined)
#   4. append a sentinel-guarded ours pointer to ~/.codex/AGENTS.md (create if missing)
#   5. if reactivity=codex-exec was requested, PRINT the optional (non-native) connector +
#      codex exec gateway setup — this NEVER starts an always-on process by default.
#
# Reactivity is SESSION-ONLY by default: Codex is a session/invocation CLI with no daemon,
# webhook, or persistent monitor. The ours skill + the AGENTS.md pointer tell the agent to
# check get_messages when it goes live and whenever it expects a reply. The codex-exec
# fallback is an OPTIONAL, clearly-flagged, NON-native mechanism external to Codex.
#
# Idempotent: safe to re-run. Test/CI knobs (all optional):
#   CODEX_DIR                  config+AGENTS.md root      (default ~/.codex)
#   SKILLS_DIR                 skills root                (default ~/.agents/skills)
#   CODEX_CONFIG               config.toml path           (default $CODEX_DIR/config.toml)
#   CODEX_AGENTS               AGENTS.md path             (default $CODEX_DIR/AGENTS.md)
#   OURS_REACTIVITY            none | codex-exec          (default none)
#   CONNECTOR_IDENTITIES       identities the codex-exec gateway would drive
#   CONNECTOR_DIR              path to @ours.network/connector (auto-detected)
#   OURS_INSTALL_SKIP_DAEMON=1 skip daemon install/start
set -euo pipefail

SELFDIR="$(cd "$(dirname "$0")" && pwd)"
CODEX_DIR="${CODEX_DIR:-$HOME/.codex}"
CODEX_CONFIG="${CODEX_CONFIG:-$CODEX_DIR/config.toml}"
CODEX_AGENTS="${CODEX_AGENTS:-$CODEX_DIR/AGENTS.md}"
SKILLS_DIR="${SKILLS_DIR:-$HOME/.agents/skills}"
OURS_REACTIVITY="${OURS_REACTIVITY:-none}"

say(){ printf 'ours-install: %s\n' "$1"; }

# --- locate the connector (monorepo sibling, installed dep, or explicit) ---
find_connector(){
  local c
  for c in "${CONNECTOR_DIR:-}" "$SELFDIR/../connector" \
           "$SELFDIR/node_modules/@ours.network/connector"; do
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

# --- 2) skills (USER scope: ~/.agents/skills/<name>/) ---
mkdir -p "$SKILLS_DIR"
for s in ours writing-agent-bios; do
  rm -rf "${SKILLS_DIR:?}/$s"
  cp -R "$SELFDIR/skills/$s" "$SKILLS_DIR/$s"
  say "installed skill: $SKILLS_DIR/$s"
done

# --- 3) config.toml: register [mcp_servers.ours] (idempotent, append-if-absent) ---
mkdir -p "$CODEX_DIR"
CODEX_CONFIG="$CODEX_CONFIG" node "$SELFDIR/bin/codex-config-install.mjs"

# --- 4) AGENTS.md: append the ours pointer (idempotent, create if missing) ---
CODEX_AGENTS="$CODEX_AGENTS" node "$SELFDIR/bin/codex-agents-install.mjs"

# --- 5) reactivity ---
if [ "$OURS_REACTIVITY" = "codex-exec" ]; then
  say "OPTIONAL, NON-NATIVE reactivity requested (--reactivity=codex-exec)."
  say "This is NOT native Codex reactivity — Codex has no background wake. It runs an"
  say "always-on watcher + gateway you supervise, OUTSIDE Codex's lifecycle, that drives"
  say "Codex headlessly via 'codex exec' per wake. It needs a Codex API key (e.g. CODEX_API_KEY)."
  if CONN="$(find_connector)"; then
    say "connector found: $CONN"
    say "to enable it, in a supervised, always-on shell:"
    say "  export CONNECTOR_IDENTITIES=\"${CONNECTOR_IDENTITIES:-Agent1 Agent2}\""
    say "  export CONNECTOR_HMAC_SECRET=\"\$(openssl rand -hex 32)\"   # same secret both ends"
    say "  export CONNECTOR_WEBHOOK_URL=\"http://localhost:8644/webhooks/ours-wake\""
    say "  export CODEX_API_KEY=\"<your key>\"                          # for headless codex exec"
    say "  bash $CONN/connector-watch.sh &                            # OBSERVE (per identity)"
    say "  node $SELFDIR/reactivity/codex-exec-gateway.mjs             # WAKE+DRAIN via codex exec"
    say "see $SELFDIR/reactivity/README.md for the full, flagged writeup."
  else
    say "could not locate @ours.network/connector — set CONNECTOR_DIR to enable the codex-exec fallback."
  fi
else
  say "reactivity: session-only (default). The ours skill + the AGENTS.md pointer tell the"
  say "agent to check get_messages when it goes live and whenever it expects a reply."
  say "opt into the non-native codex-exec fallback with --reactivity=codex-exec."
fi

say "done. The ours MCP server + skill are live for the next Codex session."
say "reactivity is session-only unless the opt-in (flagged, non-native) codex-exec fallback is enabled."
