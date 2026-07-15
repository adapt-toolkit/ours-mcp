#!/usr/bin/env bash
# ours.network — unified stack installer bootstrap (the `ours-install` experience). Meant to be run
# as:
#
#     curl -fsSL https://raw.githubusercontent.com/adapt-toolkit/ours-mcp/main/packages/installer/install.sh | bash
#
# This file is a THIN bootstrap: it checks that Node.js is present (and prints friendly, per-OS
# guidance if it isn't), then hands off to the real experience — a Node installer (install.mjs)
# that guides the WHOLE stack in ~3 minutes: pre-flight (platform / node / harness alias-safety),
# config-first (broker + port), then four consent-gated steps — ours core (the daemon), the harness
# plugins (Claude Code + Codex), ours-fleet, and the Telegram connector — ending in ONE copy-paste
# hand-off prompt. All the real work lives in the Node installer.
#
# Piped as `curl … | bash` there is no install.mjs on disk next to us, so we download the small
# installer file set into a temp dir and run it. Run from a clone, we use the local files.
#
# Non-interactive env overrides (all optional) — consumed by the Node installer:
#   OURS_ASSUME_YES=1                        accept every default; never prompt (no tty needed)
#   OURS_INSTALL_DRY_RUN=1                   walk the whole flow WITHOUT installing/changing anything
#                                            (prints exactly what it WOULD do — safe on any machine)
#   OURS_NPM="npm"                           npm binary to use
#   OURS_CONFIG=/path/config.json            daemon config file (default ~/.ours/config.json)
#   OURS_INSTALLER_MJS=/path/install.mjs     run this Node installer directly (dev/testing)
#   OURS_INSTALLER_BASE=<url>                base URL to download the installer file set from
#   OURS_INSTALL_REF=<git ref>               piped runs fetch the installer from this branch/tag
#                                            of the GitHub repo instead of main (dev/testing)
set -euo pipefail

say(){ printf 'ours: %s\n' "$1"; }

# --- 1) Node.js check + friendly guidance ------------------------------------------------------
# The Node installer needs Node.js ≥ 20. If it's missing, don't fail cryptically: explain what
# Node is and how to get it for this OS, point at nodejs.org, and exit cleanly (0) so a piped run
# ends gracefully rather than with a scary non-zero error.
if ! command -v node >/dev/null 2>&1; then
  os="$(uname -s 2>/dev/null || echo unknown)"
  printf '\n'
  say "ours needs Node.js (version 20 or newer) to run its installer — it isn't installed yet."
  say "Node.js is a common, free runtime; here's how to get it:"
  case "$os" in
    Darwin)
      say "  • macOS (Homebrew):  brew install node"
      say "  • or nvm:            https://github.com/nvm-sh/nvm  then  nvm install --lts" ;;
    Linux)
      say "  • Debian/Ubuntu:     https://github.com/nodesource/distributions  (NodeSource)"
      say "  • or nvm:            https://github.com/nvm-sh/nvm  then  nvm install --lts" ;;
    *)
      say "  • Windows/WSL:       install Node.js in WSL, or from https://nodejs.org" ;;
  esac
  say "  • Or download the installer for any OS: https://nodejs.org"
  say "Once Node.js is installed, re-run this command and you're set."
  printf '\n'
  exit 0
fi

# --- 2) locate the Node installer --------------------------------------------------------------
# Preference order: explicit override (dev/testing) → local sibling (clone) → download (piped).
MJS=""
if [ -n "${OURS_INSTALLER_MJS:-}" ] && [ -f "${OURS_INSTALLER_MJS}" ]; then
  MJS="${OURS_INSTALLER_MJS}"
else
  # dirname of THIS script (empty/curl → not a real path, sibling check simply misses).
  SELF="${BASH_SOURCE[0]:-$0}"
  DIR="$(cd "$(dirname "$SELF")" 2>/dev/null && pwd || true)"
  if [ -n "$DIR" ] && [ -f "$DIR/install.mjs" ]; then
    MJS="$DIR/install.mjs"
  fi
fi

CLEANUP=""
if [ -z "$MJS" ]; then
  # Piped run: download the (small, stable) installer file set, preserving the lib/ layout.
  BASE="${OURS_INSTALLER_BASE:-https://raw.githubusercontent.com/adapt-toolkit/ours-mcp/${OURS_INSTALL_REF:-main}/packages/installer}"
  fetch(){ if command -v curl >/dev/null 2>&1; then curl -fsSL "$1"; else wget -qO- "$1"; fi; }
  TMP="$(mktemp -d)"; CLEANUP="$TMP"
  mkdir -p "$TMP/lib"
  say "fetching the ours installer…"
  for f in install.mjs lib/ui.mjs lib/logic.mjs lib/prompt.mjs; do
    if ! fetch "$BASE/$f" > "$TMP/$f" 2>/dev/null; then
      say "could not download the installer ($BASE/$f). Check your connection and retry."
      rm -rf "${TMP:?}"; exit 1
    fi
  done
  MJS="$TMP/install.mjs"
fi

# --- 3) run the Node installer -----------------------------------------------------------------
# Keep it in the foreground so its /dev/tty prompts reach the user. Clean up any temp download.
set +e
node "$MJS"
rc=$?
set -e
[ -n "$CLEANUP" ] && rm -rf "${CLEANUP:?}"
exit "$rc"
