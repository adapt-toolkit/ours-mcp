#!/usr/bin/env bash
# ours.network — one-shot installer.  Hosted on git and meant to be run as:
#
#     curl -fsSL https://raw.githubusercontent.com/adapt-toolkit/ours-mcp/main/packages/installer/install.sh | bash
#
# (A pretty https://ours.network/install.sh redirect to this file is a future optional
#  convenience; the git raw URL above is the canonical source.)
#
# It is the capstone over the per-harness installers: it installs + starts the ours
# daemon, offers to install it as a persistent service, then lets you multi-select which
# agent harnesses to wire up (Claude Code / Codex / Hermes / OpenClaw) and runs each one's
# plugin installer for you. No manual "now do X, now press start" follow-up.
#
# Piped as `curl … | bash`, the script's stdin is the pipe, so all interactive prompts are
# read from the controlling terminal (/dev/tty). When there is no tty (true headless / CI),
# it falls back to environment variables — see "Non-interactive" below — and otherwise makes
# safe do-nothing choices rather than blocking.
#
# Non-interactive env overrides (all optional):
#   OURS_HARNESSES="codex hermes openclaw"   harnesses to set up (space/comma list;
#                                            names: claude-code codex hermes openclaw; or "all")
#   OURS_SERVICE=yes|no                      install the daemon as a persistent service
#   OURS_IDENTITIES="Agent1 Agent2"          identities to watch for wake-on-mail (reactive harnesses)
#   OURS_ASSUME_YES=1                        accept defaults; never prompt (implies no tty needed)
#   OURS_NPM="npm"                           npm binary to use
set -euo pipefail

NPM="${OURS_NPM:-npm}"
say(){ printf 'ours: %s\n' "$1"; }
hr(){ printf '\n\033[1m%s\033[0m\n' "$1"; }

# --- terminal-aware prompt: read from /dev/tty so `curl | bash` still works ------------
# Probe by actually OPENING /dev/tty read-write, not by `[ -r/-w ]`: the device node is
# world rw (crw-rw-rw-), so the permission test PASSES even with no controlling terminal
# (true headless / CI), and we'd then try to prompt on an unopenable /dev/tty and die. An
# open() of /dev/tty with no controlling terminal fails (ENXIO), so this only sets TTY when
# a terminal is genuinely there; otherwise we fall back to env vars / safe do-nothing.
TTY=""
if { : <>/dev/tty; } 2>/dev/null; then TTY=/dev/tty; fi

# ask <prompt> <default> -> echoes the answer (default when non-interactive / empty input)
ask(){
  local prompt="$1" def="${2:-}" ans=""
  if [ -n "${OURS_ASSUME_YES:-}" ] || [ -z "$TTY" ]; then printf '%s' "$def"; return 0; fi
  printf '%s' "$prompt" > "$TTY"
  IFS= read -r ans < "$TTY" || ans=""
  [ -z "$ans" ] && ans="$def"
  printf '%s' "$ans"
}
# yes/no helper (default shown in the prompt caps)
ask_yn(){
  local prompt="$1" def="${2:-n}" hint="[y/N]" a
  [ "$def" = "y" ] && hint="[Y/n]"
  a="$(ask "$prompt $hint " "$def")"
  case "$a" in [Yy]*) return 0;; *) return 1;; esac
}

# --- 0) prerequisites ------------------------------------------------------------------
command -v "$NPM" >/dev/null 2>&1 || { say "npm is required but not found. Install Node.js ≥ 20 first: https://nodejs.org"; exit 1; }

hr "ours.network installer"
say "This will install the ours daemon and set up the agent harnesses you choose."

# --- 1) daemon: install + start --------------------------------------------------------
hr "1) ours daemon (@ours.network/mcp)"
if ! command -v ours-mcp >/dev/null 2>&1; then
  say "installing @ours.network/mcp globally…"
  "$NPM" i -g @ours.network/mcp
else
  say "ours-mcp already installed ($(command -v ours-mcp))."
fi
if ours-mcp status >/dev/null 2>&1; then
  say "daemon already running."
else
  say "starting the daemon…"; ours-mcp start || say "could not auto-start; run 'ours-mcp start' if the tools error."
fi

# --- 2) persistent service (optional) --------------------------------------------------
hr "2) persistent service (survives reboot)"
svc="${OURS_SERVICE:-}"
if [ -z "$svc" ]; then
  if ask_yn "Install the ours daemon as a persistent service so it survives reboot?" "n"; then svc=yes; else svc=no; fi
fi
if [ "$svc" = "yes" ]; then
  say "installing the persistent service…"
  ours-mcp install-service || say "service install failed (non-fatal); you can retry 'ours-mcp install-service' later."
else
  say "skipping the persistent service (start it on demand with 'ours-mcp start')."
fi

# --- 3) select harnesses ---------------------------------------------------------------
hr "3) agent harnesses"
# Normalize a selection string (numbers, names, or "all") into canonical harness names.
canon_harnesses(){
  local raw="$1" out=""
  raw="$(printf '%s' "$raw" | tr ',' ' ' | tr '[:upper:]' '[:lower:]')"
  for tok in $raw; do
    case "$tok" in
      all|a)               out="claude-code codex hermes openclaw"; break;;
      1|claude-code|claude|cc) out="$out claude-code";;
      2|codex)             out="$out codex";;
      3|hermes)            out="$out hermes";;
      4|openclaw)          out="$out openclaw";;
      none|skip|0)         : ;;
      *)                   say "  (ignoring unknown harness '$tok')" >&2;;
    esac
  done
  # de-dupe, preserve order
  printf '%s\n' $out | awk '!seen[$0]++' | tr '\n' ' '
}

if [ -n "${OURS_HARNESSES:-}" ]; then
  SELECTED="$(canon_harnesses "$OURS_HARNESSES")"
else
  if [ -z "$TTY" ] && [ -z "${OURS_ASSUME_YES:-}" ]; then
    say "no terminal and no OURS_HARNESSES set — skipping harness setup (daemon is installed)."
    SELECTED=""
  else
    printf '%s' "\
  Which harnesses do you want to set up? Enter numbers (space-separated), names, or 'all':
    1) Claude Code   2) Codex   3) Hermes   4) OpenClaw
  > " > "${TTY:-/dev/stdout}"
    reply=""; [ -n "$TTY" ] && { IFS= read -r reply < "$TTY" || reply=""; }
    SELECTED="$(canon_harnesses "${reply:-none}")"
  fi
fi
SELECTED="$(printf '%s' "$SELECTED" | sed -E 's/^ +| +$//g')"

if [ -z "$SELECTED" ]; then
  hr "Done"
  say "Daemon is set up. No harness selected — re-run any time, or install one directly:"
  say "  npm i -g @ours.network/{hermes,openclaw,codex} && ours-<harness>-install"
  exit 0
fi
say "setting up: $SELECTED"

# identities to watch (asked once, reused for reactive harnesses)
IDENTITIES="${OURS_IDENTITIES:-}"
case " $SELECTED " in
  *" hermes "*|*" openclaw "*)
    if [ -z "$IDENTITIES" ]; then
      IDENTITIES="$(ask "  Identities to wake on new mail (space-separated, Enter to skip live wake): " "")"
    fi ;;
esac

# --- 4) run each selected harness's installer ------------------------------------------
install_npm_harness(){  # $1 = harness (hermes|openclaw|codex)
  local h="$1" pkg="@ours.network/$1" bin="ours-$1-install"
  hr "→ $h"
  say "installing $pkg…"; "$NPM" i -g "$pkg"
  local args=()
  case "$h" in
    hermes|openclaw) [ -n "$IDENTITIES" ] && args=(--identities "$IDENTITIES");;
  esac
  say "running $bin ${args[*]:-}"
  "$bin" "${args[@]}"
}

FAILED=""
for h in $SELECTED; do
  case "$h" in
    hermes|openclaw|codex)
      install_npm_harness "$h" || { FAILED="$FAILED $h"; say "  $h setup failed (continuing)."; }
      ;;
    claude-code)
      hr "→ claude-code"
      # Claude Code plugins install from its in-app marketplace, not a shell bin. Do the
      # part we can (the daemon is already up) and print the two in-Claude-Code commands.
      say "Claude Code installs its plugin from the in-app marketplace. Inside Claude Code, run:"
      say "    /plugin marketplace add adapt-toolkit/ours-claude-marketplace"
      say "    /plugin install ours.network"
      say "(The daemon this installer set up is what that plugin talks to.)"
      ;;
  esac
done

# --- done ------------------------------------------------------------------------------
hr "Done"
say "ours daemon: $(command -v ours-mcp)"
[ -n "$SELECTED" ] && say "harnesses: $SELECTED"
if [ -n "$FAILED" ]; then say "note: failed to fully set up:$FAILED — re-run or install those directly."; fi
say "Reload each harness (Hermes/OpenClaw: 'openclaw gateway restart' / '/reload-mcp'; Codex: next session) to load the ours tools."
