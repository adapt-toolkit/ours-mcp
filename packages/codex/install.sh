#!/usr/bin/env bash
# Install the native ours.network plugin into the OpenAI Codex CLI:
#   1. ensure the ours daemon (@ours.network/mcp) is installed + running
#   2. add/upgrade adapt-toolkit/ours-codex-marketplace
#   3. install the native `ours` plugin (skills, MCP servers, and hooks)
#   4. back up and remove installer-owned legacy config only after verification
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

# Ensure the ours daemon is on @latest (UPGRADE, not install-if-missing): an already-present
# daemon must still be pulled up to the newest published version. Record the CLI version
# before/after; start if not running, restart only if the version actually changed.
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

# --- 1) daemon (ensure @latest + restart on change) ---
ensure_daemon_latest

# --- native Codex plugin ------------------------------------------------------
# Codex owns the plugin cache and hook-trust workflow. Only remove the legacy
# config/skills/AGENTS wiring after Codex confirms the native plugin installed.
if [ "${OURS_CODEX_SKIP_NATIVE:-}" != "1" ]; then
  if ! command -v codex >/dev/null 2>&1; then
    say "Codex CLI is required; install Codex first. Existing ours setup was left unchanged."
    exit 1
  fi
  MARKETPLACE_SOURCE="${OURS_CODEX_MARKETPLACE_SOURCE:-adapt-toolkit/ours-codex-marketplace}"
  say "adding/updating Codex marketplace: $MARKETPLACE_SOURCE"
  if ! codex plugin marketplace add "$MARKETPLACE_SOURCE" >/dev/null 2>&1; then
    codex plugin marketplace upgrade ours-codex-marketplace >/dev/null 2>&1 || {
      say "could not configure the ours Codex marketplace; existing setup was left unchanged."
      exit 1
    }
  fi
  say "installing native Codex plugin: ours@ours-codex-marketplace"
  if ! codex plugin add ours@ours-codex-marketplace; then
    say "native plugin installation failed; existing setup was left unchanged."
    exit 1
  fi
  CODEX_DIR="$CODEX_DIR" SKILLS_DIR="$SKILLS_DIR" node "$SELFDIR/bin/codex-legacy-cleanup.mjs"
  say "native plugin installed. Review and trust its hooks in Codex, then start a new thread."
  say "standard mode: codex"
  say "live mode:     ours-codex${OURS_PORT:+ --ours-port $OURS_PORT}"
  exit 0
fi

# --- legacy test/fallback path (not used by production installs) -------------
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
# --- version echo: show the user they are on latest ---
if [ "${OURS_INSTALL_SKIP_DAEMON:-}" != "1" ]; then
  say "versions:"
  say "  daemon: $(ours-mcp --version 2>/dev/null | head -1 || echo 'unknown')"
  say "  plugin: $(npm ls -g @ours.network/codex 2>/dev/null | grep -oE '@ours\.network/codex@[0-9][0-9.]*' | head -1 || echo '@ours.network/codex (not a global install)')"
fi
say "next: bind (or create) an identity, then the ours skill tails ours-mcp watch (or polls"
say "      get_messages) in-session so you react to new mail while you work."
