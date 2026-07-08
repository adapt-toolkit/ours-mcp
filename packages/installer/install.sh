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
# The base install is deliberately dead-simple: daemon + MCP server + skill per harness. It
# asks ZERO questions about identities or wake-on-mail — those are set up later from inside the
# agent (bind an identity, then ask the ours skill to "wake me on new mail"), never here.
#
# Non-interactive env overrides (all optional):
#   OURS_HARNESSES="codex hermes openclaw"   harnesses to set up (space/comma list;
#                                            names: claude-code codex hermes openclaw; or "all")
#   OURS_SERVICE=yes|no                      install the daemon as a persistent service
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

# Interactive checkbox multi-select drawn on the controlling terminal. ↑/↓ (or k/j) move,
# Space toggles, Enter confirms, a/n select-all / none, q cancels (selects nothing). ALL UI is
# written to $TTY and keys are read from $TTY, so only the resulting space-separated harness
# names reach stdout — safe to capture with $(...). Callers gate on $TTY (headless uses
# OURS_HARNESSES instead). Args are "name=Label" specs.
checkbox_select(){
  local names=() labels=() sel=()
  local spec
  for spec in "$@"; do names+=("${spec%%=*}"); labels+=("${spec#*=}"); sel+=(0); done
  local n=${#names[@]} i cur=0 drawn=0

  redraw(){
    [ "$drawn" = 1 ] && printf '\033[%dA' "$n" > "$TTY"   # rewind over the previous frame
    drawn=1
    for ((i=0; i<n; i++)); do
      local box='[ ]'; [ "${sel[$i]}" = 1 ] && box='[x]'
      local point='  '; [ "$i" = "$cur" ] && point='> '
      printf '\r\033[K  %s%s %s\n' "$point" "$box" "${labels[$i]}" > "$TTY"
    done
  }

  printf '  Choose harnesses to set up — %s move, %s toggle, %s confirm (a=all, n=none):\n' \
    $'\033[1m↑/↓\033[0m' $'\033[1mSpace\033[0m' $'\033[1mEnter\033[0m' > "$TTY"
  redraw
  local key rest
  while :; do
    IFS= read -rsn1 key < "$TTY" || break
    case "$key" in
      $'\e')  # escape sequence: grab the rest of an arrow key (already buffered)
        IFS= read -rsn2 -t 0.1 rest < "$TTY" || rest=''
        case "$rest" in
          '[A'|'OA') cur=$(( (cur - 1 + n) % n ));;
          '[B'|'OB') cur=$(( (cur + 1) % n ));;
        esac ;;
      k|K) cur=$(( (cur - 1 + n) % n ));;
      j|J) cur=$(( (cur + 1) % n ));;
      ' ') sel[$cur]=$(( 1 - sel[$cur] ));;
      a|A) for ((i=0; i<n; i++)); do sel[$i]=1; done;;
      n|N) for ((i=0; i<n; i++)); do sel[$i]=0; done;;
      q|Q) for ((i=0; i<n; i++)); do sel[$i]=0; done; break;;
      '') break;;   # Enter
    esac
    redraw
  done
  local out=''
  for ((i=0; i<n; i++)); do [ "${sel[$i]}" = 1 ] && out="$out ${names[$i]}"; done
  printf '%s' "${out# }"
}

if [ -n "${OURS_HARNESSES:-}" ]; then
  SELECTED="$(canon_harnesses "$OURS_HARNESSES")"
elif [ -n "$TTY" ]; then
  SELECTED="$(canon_harnesses "$(checkbox_select \
    'claude-code=Claude Code' 'codex=Codex' 'hermes=Hermes' 'openclaw=OpenClaw')")"
else
  say "no terminal and no OURS_HARNESSES set — skipping harness setup (daemon is installed)."
  SELECTED=""
fi
SELECTED="$(printf '%s' "$SELECTED" | sed -E 's/^ +| +$//g')"

if [ -z "$SELECTED" ]; then
  hr "Done"
  say "Daemon is set up. No harness selected — re-run any time, or install one directly:"
  say "  npm i -g @ours.network/{hermes,openclaw,codex} && ours-<harness>-install"
  exit 0
fi
say "setting up: $SELECTED"

# --- 4) run each selected harness's installer ------------------------------------------
# The base install is intentionally identity-free: each harness installer sets up the daemon,
# the ours MCP server, and the skill only — no identity or wake questions. Wake-on-mail is
# enabled later from inside the agent (bind an identity, then ask the ours skill to "wake me on
# new mail"), never here.
install_npm_harness(){  # $1 = harness (hermes|openclaw|codex)
  local h="$1" pkg="@ours.network/$1" bin="ours-$1-install"
  hr "→ $h"
  say "installing $pkg…"; "$NPM" i -g "$pkg"
  say "running $bin"
  "$bin"
}

FAILED=""; INSTALLED=""
for h in $SELECTED; do
  case "$h" in
    hermes|openclaw|codex)
      # These install automatically. On success, print a clear ✓ line; the final summary lists them.
      if install_npm_harness "$h"; then
        say "✓ $h installed and working."
        INSTALLED="$INSTALLED $h"
      else
        FAILED="$FAILED $h"; say "✗ $h setup failed (continuing)."
      fi
      ;;
    claude-code)
      hr "→ claude-code"
      # Claude Code plugins install from its in-app marketplace, not a shell bin — the installer
      # cannot do it for you. Print the two commands and STOP so they can't scroll past unseen;
      # wait for an explicit continue on the tty (headless just prints and proceeds).
      say "Claude Code installs its plugin from its in-app marketplace — the installer can't do"
      say "this part for you. Inside your Claude Code session, run these TWO commands:"
      printf '\n    /plugin marketplace add adapt-toolkit/ours-claude-marketplace\n    /plugin install ours.network\n\n'
      say "(The daemon this installer set up is what that plugin talks to.)"
      if [ -n "$TTY" ] && [ -z "${OURS_ASSUME_YES:-}" ]; then
        printf '  Copy the 2 commands above and run them inside Claude Code, then press Enter to continue… ' > "$TTY"
        IFS= read -r _ < "$TTY" || true
      fi
      INSTALLED="$INSTALLED claude-code"
      ;;
  esac
done

# --- done ------------------------------------------------------------------------------
hr "Done"
say "ours daemon: $(command -v ours-mcp)"
if [ -n "$INSTALLED" ]; then
  say "installed:"
  for h in $INSTALLED; do say "  ✓ $h"; done
fi
if [ -n "$FAILED" ]; then say "note: failed to fully set up:$FAILED — re-run or install those directly."; fi
say "Reload each harness (Hermes/OpenClaw: 'openclaw gateway restart' / '/reload-mcp'; Codex: next session) to load the ours tools."
hr "Optional: get woken on new mail"
say "This install does NOT set up wake-on-mail — you enable it later from inside your agent, so"
say "it can wake itself just like Claude Code does. Open the ours skill in your harness, bind (or"
say "create) an identity, then ask it to \"wake me on new mail\" — it starts a background watcher"
say "that pings your agent whenever someone messages that identity. (Codex has no background wake;"
say "it checks for mail when it goes live.) See each plugin's README \"Optional: get woken on new mail\"."
