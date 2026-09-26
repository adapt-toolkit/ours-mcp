#!/usr/bin/env bash
# Install the ours.network plugin into Hermes:
#   1. verify the installed gateway client profile before modifying plugin configuration
#   2. install the ours + writing-agent-bios skills into ~/.hermes/skills/
#   3. write the `ours` MCP server into ~/.hermes/config.yaml (idempotent, never corrupts
#      existing YAML)
#
# That's it — no identities, no webhook route, no secret, no watcher. Wake-on-mail is the agent
# tailing `ours-mcp watch <identity>` IN-SESSION (see the ours skill), exactly like Claude Code.
#
# Idempotent: safe to re-run. Test/CI knobs (all optional):
#   HERMES_DIR                 config+skills root         (default ~/.hermes)
set -euo pipefail

SELFDIR="$(cd "$(dirname "$0")" && pwd)"
HERMES_DIR="${HERMES_DIR:-$HOME/.hermes}"
HERMES_CONFIG="$HERMES_DIR/config.yaml"
SKILLS_DEST="$HERMES_DIR/skills/communication"
# Managed-block sentinels (must match hermes-config-install.mjs verbatim) — used to strip a
# LEGACY connector-era block on upgrade.
MANAGED_SENTINEL='# >>> ours.network plugin (managed block)'
MANAGED_SENTINEL_END='# <<< ours.network plugin'

say(){ printf 'ours-install: %s\n' "$1"; }

# Client installation never installs, starts or restarts server services.
require_gateway_client(){
  if ! command -v ours >/dev/null 2>&1 || ! command -v ours-mcp >/dev/null 2>&1; then
    say "Install gateway clients with ours-install client first; ours and ours-mcp are required."
    return 1
  fi
  if ! ours config show --json >/dev/null; then
    say "Configure the shared gateway profile with ours-install client first; plugin setup was left unchanged."
    return 1
  fi
}

# Idempotent, GUARDED cleanup of legacy connector-era artifacts earlier (0.2.0/0.3.0) installers
# wrote. Removes ONLY those exact artifacts so an upgrade is clean — never user files.
legacy_cleanup(){
  local f tmp
  for f in "$HERMES_DIR/ours-connector.env" "$HERMES_DIR/ours-connector.log"; do
    [ -f "$f" ] && rm -f "$f" && say "removed legacy connector artifact: $f"
  done
  # Stop a leftover reactivity watcher the old installer may have launched.
  pkill -f 'connector-watch.sh' 2>/dev/null && say "stopped a leftover connector watcher" || true
  # Strip the managed config block ONLY when it is the LEGACY variant — i.e. it still carries the
  # connector-era webhook wake route (`ours-wake`). The current block is mcp_servers.ours only, so
  # this never touches an up-to-date block; config-install (step 3) then re-writes the current one.
  if [ -f "$HERMES_CONFIG" ] && grep -qF "$MANAGED_SENTINEL" "$HERMES_CONFIG" 2>/dev/null \
     && grep -qiE 'ours-wake|ours_wake' "$HERMES_CONFIG" 2>/dev/null; then
    tmp="$(mktemp)"
    awk -v s="$MANAGED_SENTINEL" -v e="$MANAGED_SENTINEL_END" '
      index($0,s){skip=1}
      skip && index($0,e){skip=0; next}
      !skip{print}
    ' "$HERMES_CONFIG" > "$tmp" && mv "$tmp" "$HERMES_CONFIG" \
      && say "removed legacy connector wake-route block from $HERMES_CONFIG (re-adding the current mcp-only block)"
  fi
}

# --- 1) shared gateway client preflight ---
require_gateway_client

# --- 1b) legacy connector-era cleanup (idempotent, guarded) ---
legacy_cleanup

# --- 2) skills ---
mkdir -p "$SKILLS_DEST"
for s in ours writing-agent-bios; do
  rm -rf "${SKILLS_DEST:?}/$s"
  cp -R "$SELFDIR/skills/$s" "$SKILLS_DEST/$s"
  say "installed skill: $SKILLS_DEST/$s"
done

# --- 3) config.yaml: register the ours MCP server (idempotent, safe merge) ---
mkdir -p "$HERMES_DIR"
HERMES_CONFIG="$HERMES_CONFIG" node "$SELFDIR/bin/hermes-config-install.mjs" || {
  rc=$?; [ "$rc" = "3" ] && say "config needs a manual merge (see block above)"; [ "$rc" = "3" ] || exit "$rc";
}

say "done. Run /reload-mcp in Hermes to load the mcp_ours_* tools."
say "next: in your agent, bind (or create) an identity and ask the ours skill to \"wake me on new"
say "      mail\" — it tails ours-mcp watch in-session and reacts to new mail as it arrives."
