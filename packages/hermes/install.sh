#!/usr/bin/env bash
# Install the ours.network plugin into Hermes:
#   1. ensure the ours daemon (@ours.network/mcp) is installed + running
#   2. install the ours + writing-agent-bios skills into ~/.hermes/skills/
#   3. write the `ours` MCP server into ~/.hermes/config.yaml (idempotent, never corrupts
#      existing YAML)
#
# That's it — no identities, no webhook route, no secret, no watcher. Wake-on-mail is the agent
# tailing `ours-mcp watch <identity>` IN-SESSION (see the ours skill), exactly like Claude Code.
#
# Idempotent: safe to re-run. Test/CI knobs (all optional):
#   HERMES_DIR                 config+skills root         (default ~/.hermes)
#   OURS_INSTALL_SKIP_DAEMON=1 skip daemon install/start
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

# Ensure the ours daemon is on @latest (UPGRADE, not install-if-missing): an already-present
# daemon must still be pulled up to the newest published version — that is the whole point of a
# re-run. Record the CLI version before/after; start if not running, restart only if the version
# actually changed, so the RUNNING daemon always ends on latest.
ensure_daemon_latest(){
  if [ "${OURS_INSTALL_SKIP_DAEMON:-}" = "1" ]; then say "skipping daemon step (OURS_INSTALL_SKIP_DAEMON=1)"; return 0; fi
  local before after
  before="$(ours-mcp --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
  say "ensuring @ours.network/mcp@latest…"
  npm i -g @ours.network/mcp@latest
  after="$(ours-mcp --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
  if ! ours-mcp status >/dev/null 2>&1; then
    say "starting the ours daemon…"; ours-mcp start || say "could not auto-start; run 'ours-mcp start' if the tools error."
  elif [ -n "$before" ] && [ "$before" != "$after" ]; then
    say "daemon upgraded (v${before} → v${after}) — restarting…"; ours-mcp restart || ours-mcp start || true
  else
    say "daemon already current (v${after:-unknown})."
  fi
  say "daemon: $(command -v ours-mcp) (v${after:-unknown})"
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

# --- 1) daemon (ensure @latest + restart on change) ---
ensure_daemon_latest

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
# --- version echo: show the user they are on latest ---
if [ "${OURS_INSTALL_SKIP_DAEMON:-}" != "1" ]; then
  say "versions:"
  say "  daemon: $(ours-mcp --version 2>/dev/null | head -1 || echo 'unknown')"
  say "  plugin: $(npm ls -g @ours.network/hermes 2>/dev/null | grep -oE '@ours\.network/hermes@[0-9][0-9.]*' | head -1 || echo '@ours.network/hermes (not a global install)')"
fi
say "next: in your agent, bind (or create) an identity and ask the ours skill to \"wake me on new"
say "      mail\" — it tails ours-mcp watch in-session and reacts to new mail as it arrives."
