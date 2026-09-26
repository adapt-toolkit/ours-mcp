#!/usr/bin/env bash
# Install the native ours.network plugin into the OpenAI Codex CLI:
#   1. verify the installed gateway client profile before modifying plugin configuration
#   2. add/upgrade adapt-toolkit/ours-codex-marketplace
#   3. install the native `ours` plugin (skills, MCP servers, and hooks)
#   4. back up and remove installer-owned legacy config only after verification
#
# Idempotent: safe to re-run. Test/CI knobs (all optional):
#   CODEX_DIR                  config+AGENTS.md root      (default ~/.codex)
#   SKILLS_DIR                 skills root                (default ~/.agents/skills)
#   CODEX_CONFIG               config.toml path           (default $CODEX_DIR/config.toml)
#   CODEX_AGENTS               AGENTS.md path             (default $CODEX_DIR/AGENTS.md)
set -euo pipefail

SELFDIR="$(cd "$(dirname "$0")" && pwd)"
CODEX_DIR="${CODEX_DIR:-$HOME/.codex}"
CODEX_CONFIG="${CODEX_CONFIG:-$CODEX_DIR/config.toml}"
CODEX_AGENTS="${CODEX_AGENTS:-$CODEX_DIR/AGENTS.md}"
SKILLS_DIR="${SKILLS_DIR:-$HOME/.agents/skills}"

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

# --- 1) shared gateway client preflight ---
require_gateway_client

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
  say "live mode:     ours-codex"
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
say "next: bind (or create) an identity, then the ours skill tails ours-mcp watch (or polls"
say "      get_messages) in-session so you react to new mail while you work."
