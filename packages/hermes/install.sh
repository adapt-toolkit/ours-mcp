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

say(){ printf 'ours-install: %s\n' "$1"; }

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

# --- 3) config.yaml: register the ours MCP server (idempotent, safe merge) ---
mkdir -p "$HERMES_DIR"
HERMES_CONFIG="$HERMES_CONFIG" node "$SELFDIR/bin/hermes-config-install.mjs" || {
  rc=$?; [ "$rc" = "3" ] && say "config needs a manual merge (see block above)"; [ "$rc" = "3" ] || exit "$rc";
}

say "done. Run /reload-mcp in Hermes to load the mcp_ours_* tools."
say "next: in your agent, bind (or create) an identity and ask the ours skill to \"wake me on new"
say "      mail\" — it tails ours-mcp watch in-session and reacts to new mail as it arrives."
