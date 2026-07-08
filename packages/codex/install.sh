#!/usr/bin/env bash
# Install the ours.network plugin into the OpenAI Codex CLI:
#   1. ensure the ours daemon (@ours.network/mcp) is installed + running
#   2. install the ours + writing-agent-bios skills into ~/.agents/skills/ (USER scope)
#   3. register the `ours` MCP server ([mcp_servers.ours]) in ~/.codex/config.toml
#      (idempotent — appends the table only if it is not already defined)
#   4. append a sentinel-guarded ours pointer to ~/.codex/AGENTS.md (create if missing)
#
# That's it — no identities, no gateway, no watcher, no connector. Wake-on-mail is the agent
# tailing `ours-mcp watch <identity>` (or a short get_messages poll) IN-SESSION (see the ours
# skill), the same stream Claude Code's Monitor tails. Codex is a session/invocation CLI, so this
# is reactive while the agent is live — it checks for mail as it works and when it expects a reply.
#
# Idempotent: safe to re-run. Test/CI knobs (all optional):
#   CODEX_DIR                  config+AGENTS.md root      (default ~/.codex)
#   SKILLS_DIR                 skills root                (default ~/.agents/skills)
#   CODEX_CONFIG               config.toml path           (default $CODEX_DIR/config.toml)
#   CODEX_AGENTS               AGENTS.md path             (default $CODEX_DIR/AGENTS.md)
#   OURS_INSTALL_SKIP_DAEMON=1 skip daemon install/start
set -euo pipefail

SELFDIR="$(cd "$(dirname "$0")" && pwd)"
CODEX_DIR="${CODEX_DIR:-$HOME/.codex}"
CODEX_CONFIG="${CODEX_CONFIG:-$CODEX_DIR/config.toml}"
CODEX_AGENTS="${CODEX_AGENTS:-$CODEX_DIR/AGENTS.md}"
SKILLS_DIR="${SKILLS_DIR:-$HOME/.agents/skills}"

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

say "done. The ours MCP server + skill are live for the next Codex session."
say "next: bind (or create) an identity, then the ours skill tails ours-mcp watch (or polls"
say "      get_messages) in-session so you react to new mail while you work."
