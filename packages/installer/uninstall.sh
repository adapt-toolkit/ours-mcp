#!/usr/bin/env bash
# ours.network — uninstaller. The symmetric partner to install.sh. Run it from a clone:
#
#     bash packages/installer/uninstall.sh
#
# (or piped: curl -fsSL https://raw.githubusercontent.com/adapt-toolkit/ours-mcp/main/packages/installer/uninstall.sh | bash)
#
# It removes ONLY what the ours installers created — never unrelated files. Using the same
# interactive toggle UI as install.sh, it asks WHAT to remove:
#   • each per-harness plugin  (MCP-server config block + skill dirs + npm global, plus cleanup of
#                               any LEGACY connector env/log/route/secret from earlier builds)
#   • the ours data directory  (~/.ours — identities + keys; DESTRUCTIVE, extra confirm)
#   • the ours-mcp daemon       (stop + remove service + npm global; extra confirm)
#
# The two destructive items (data dir, daemon) require an explicit typed 'yes' before anything is
# removed. Everything uses safe, quoted, explicit paths — no wildcards on $HOME.
#
# Non-interactive env overrides (all optional):
#   OURS_UNINSTALL="hermes codex"   which harness plugins to remove (space/comma; names or "all")
#   OURS_UNINSTALL_DATA=yes         also remove the ours data dir (~/.ours)
#   OURS_UNINSTALL_DAEMON=yes       also stop + remove the ours-mcp daemon + its service
#   OURS_ASSUME_YES=1               accept defaults; skip the typed confirmations (implies no tty)
#   OURS_NPM="npm"                  npm binary to use
#   HERMES_DIR / OPENCLAW_DIR / CODEX_DIR / SKILLS_DIR / OURS_STATE_DIR   path overrides
set -euo pipefail

NPM="${OURS_NPM:-npm}"
HERMES_DIR="${HERMES_DIR:-$HOME/.hermes}"
OPENCLAW_DIR="${OPENCLAW_DIR:-$HOME/.openclaw}"
CODEX_DIR="${CODEX_DIR:-$HOME/.codex}"
SKILLS_DIR="${SKILLS_DIR:-$HOME/.agents/skills}"
OURS_STATE_DIR="${OURS_STATE_DIR:-$HOME/.ours}"

# Sentinel markers stamped by the installers' config helpers (must match them verbatim).
YAML_START='# >>> ours.network plugin (managed block)'
YAML_END='# <<< ours.network plugin'
TOML_START='# >>> ours.network plugin (managed block)'
TOML_END='# <<< ours.network plugin'
MD_START='<!-- >>> ours.network plugin (managed block) -->'
MD_END='<!-- <<< ours.network plugin -->'

say(){ printf 'ours: %s\n' "$1"; }
hr(){ printf '\n\033[1m%s\033[0m\n' "$1"; }

# --- terminal-aware prompt (same probe as install.sh: OPEN /dev/tty, don't trust perms) -------
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
# confirm_destructive <what> -> 0 only if the user types exactly 'yes' (or OURS_ASSUME_YES honored
# via the caller). Never defaults to yes.
confirm_destructive(){
  local what="$1" a
  a="$(ask "  Type 'yes' to permanently remove $what: " "no")"
  [ "$a" = "yes" ]
}

# --- interactive checkbox multi-select (identical to install.sh) ------------------------------
checkbox_select(){
  local names=() labels=() sel=()
  local spec
  for spec in "$@"; do names+=("${spec%%=*}"); labels+=("${spec#*=}"); sel+=(0); done
  local n=${#names[@]} i cur=0 drawn=0

  redraw(){
    [ "$drawn" = 1 ] && printf '\033[%dA' "$n" > "$TTY"
    drawn=1
    for ((i=0; i<n; i++)); do
      local box='[ ]'; [ "${sel[$i]}" = 1 ] && box='[x]'
      local point='  '; [ "$i" = "$cur" ] && point='> '
      printf '\r\033[K  %s%s %s\n' "$point" "$box" "${labels[$i]}" > "$TTY"
    done
  }

  printf '  Choose what to remove — %s move, %s toggle, %s confirm (a=all, n=none):\n' \
    $'\033[1m↑/↓\033[0m' $'\033[1mSpace\033[0m' $'\033[1mEnter\033[0m' > "$TTY"
  redraw
  local key rest
  while :; do
    IFS= read -rsn1 key < "$TTY" || break
    case "$key" in
      $'\e')
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
      '') break;;
    esac
    redraw
  done
  local out=''
  for ((i=0; i<n; i++)); do [ "${sel[$i]}" = 1 ] && out="$out ${names[$i]}"; done
  printf '%s' "${out# }"
}

# --- safe removal helpers ---------------------------------------------------------------------
# strip_block <file> <start-marker> <end-marker>: delete the sentinel-delimited managed block
# (inclusive) if present; leave the file untouched otherwise. Only ever removes OUR block.
strip_block(){
  local f="$1" s="$2" e="$3" tmp
  [ -f "$f" ] || return 0
  grep -qF "$s" "$f" 2>/dev/null || return 0
  tmp="$(mktemp)"
  awk -v s="$s" -v e="$e" '
    index($0,s){skip=1}
    skip && index($0,e){skip=0; next}
    !skip{print}
  ' "$f" > "$tmp" && mv "$tmp" "$f" && say "  removed the ours managed block from $f"
}

# remove_openclaw_block <openclaw.json>: structured removal (strict JSON). Deletes only our keys:
# the "//ours" sentinel, mcp.servers.ours, and any ours-wake* webhook routes. Leaves JSON5 alone.
remove_openclaw_block(){
  local f="$1"
  [ -f "$f" ] || return 0
  node -e '
    const fs = require("fs");
    const f = process.argv[1];
    let raw; try { raw = fs.readFileSync(f, "utf8"); } catch { process.exit(0); }
    let cfg;
    try { cfg = JSON.parse(raw); }
    catch (e) {
      console.error("ours:   " + f + " is not strict JSON (JSON5/comments) — leaving it untouched.");
      console.error("ours:   Remove by hand: top-level \"//ours\", mcp.servers.ours, and any");
      console.error("ours:   plugins.entries.webhooks.config.routes.ours-wake* routes.");
      process.exit(0);
    }
    let changed = false;
    if (Object.prototype.hasOwnProperty.call(cfg, "//ours")) { delete cfg["//ours"]; changed = true; }
    if (cfg.mcp && cfg.mcp.servers && cfg.mcp.servers.ours) { delete cfg.mcp.servers.ours; changed = true; }
    const routes = cfg.plugins && cfg.plugins.entries && cfg.plugins.entries.webhooks
      && cfg.plugins.entries.webhooks.config && cfg.plugins.entries.webhooks.config.routes;
    if (routes && typeof routes === "object") {
      for (const k of Object.keys(routes)) if (k.indexOf("ours-wake") === 0) { delete routes[k]; changed = true; }
    }
    if (changed) { fs.writeFileSync(f, JSON.stringify(cfg, null, 2) + "\n"); console.log("ours:   removed the ours block from " + f); }
    else console.log("ours:   no ours block found in " + f);
  ' "$f"
}

# rm_dir <dir>: quoted, explicit, refuses an empty argument (the :? guard) so a mis-set var can
# never expand to `rm -rf /` or `rm -rf $HOME`.
rm_dir(){ local d="$1"; [ -n "$d" ] || return 0; [ -e "$d" ] || return 0; rm -rf "${d:?}" && say "  removed $d"; }
rm_file(){ local f="$1"; [ -n "$f" ] || return 0; [ -e "$f" ] || return 0; rm -f "${f:?}" && say "  removed $f"; }

# --- per-harness removal ----------------------------------------------------------------------
remove_hermes(){
  hr "→ removing hermes plugin"
  strip_block "$HERMES_DIR/config.yaml" "$YAML_START" "$YAML_END"
  rm_dir "$HERMES_DIR/skills/communication/ours"
  rm_dir "$HERMES_DIR/skills/communication/writing-agent-bios"
  rm_file "$HERMES_DIR/ours-connector.env"
  rm_file "$HERMES_DIR/ours-connector.log"
  "$NPM" rm -g @ours.network/hermes 2>/dev/null && say "  npm: removed @ours.network/hermes" || say "  npm: @ours.network/hermes not installed globally (skipped)"
}

remove_openclaw(){
  hr "→ removing openclaw plugin"
  remove_openclaw_block "$OPENCLAW_DIR/openclaw.json"
  rm_dir "$OPENCLAW_DIR/skills/ours"
  rm_dir "$OPENCLAW_DIR/skills/writing-agent-bios"
  rm_file "$OPENCLAW_DIR/ours-connector.env"
  rm_file "$OPENCLAW_DIR/ours-connector.log"
  # Drop only our OURS_WAKE_SECRET line from the gateway dotenv; keep everything else.
  if [ -f "$OPENCLAW_DIR/.env" ] && grep -q '^OURS_WAKE_SECRET=' "$OPENCLAW_DIR/.env" 2>/dev/null; then
    local tmp; tmp="$(mktemp "$OPENCLAW_DIR/.env.XXXXXX")"
    grep -v '^OURS_WAKE_SECRET=' "$OPENCLAW_DIR/.env" > "$tmp" || true
    mv "$tmp" "$OPENCLAW_DIR/.env" && say "  removed OURS_WAKE_SECRET from $OPENCLAW_DIR/.env"
  fi
  "$NPM" rm -g @ours.network/openclaw 2>/dev/null && say "  npm: removed @ours.network/openclaw" || say "  npm: @ours.network/openclaw not installed globally (skipped)"
}

remove_codex(){
  hr "→ removing codex plugin"
  strip_block "$CODEX_DIR/config.toml" "$TOML_START" "$TOML_END"
  strip_block "$CODEX_DIR/AGENTS.md" "$MD_START" "$MD_END"
  rm_dir "$SKILLS_DIR/ours"
  rm_dir "$SKILLS_DIR/writing-agent-bios"
  "$NPM" rm -g @ours.network/codex 2>/dev/null && say "  npm: removed @ours.network/codex" || say "  npm: @ours.network/codex not installed globally (skipped)"
}

remove_claude_code(){
  hr "→ claude-code"
  say "Claude Code's plugin lives in its in-app marketplace — the uninstaller can't remove it."
  say "Inside your Claude Code session, run:"
  printf '\n    /plugin uninstall ours.network\n    /plugin marketplace remove adapt-toolkit/ours-claude-marketplace\n\n'
}

# --- 0) prerequisites -------------------------------------------------------------------------
command -v "$NPM" >/dev/null 2>&1 || { say "npm is required but not found."; exit 1; }

hr "ours.network uninstaller"
say "Removes only what the ours installers created. Nothing is removed until you confirm."

# --- 1) choose what to remove -----------------------------------------------------------------
canon_targets(){
  local raw="$1" out=""
  raw="$(printf '%s' "$raw" | tr ',' ' ' | tr '[:upper:]' '[:lower:]')"
  for tok in $raw; do
    case "$tok" in
      all)                     out="claude-code codex hermes openclaw";;
      claude-code|claude|cc)   out="$out claude-code";;
      codex)                   out="$out codex";;
      hermes)                  out="$out hermes";;
      openclaw)                out="$out openclaw";;
      none|skip)               : ;;
      *)                       say "  (ignoring unknown target '$tok')" >&2;;
    esac
  done
  printf '%s\n' $out | awk '!seen[$0]++' | tr '\n' ' '
}

WANT_DATA=no; WANT_DAEMON=no
if [ -n "${OURS_UNINSTALL:-}" ] || [ -n "${OURS_UNINSTALL_DATA:-}" ] || [ -n "${OURS_UNINSTALL_DAEMON:-}" ]; then
  # Headless / scripted path.
  SELECTED="$(canon_targets "${OURS_UNINSTALL:-}")"
  [ "${OURS_UNINSTALL_DATA:-}" = "yes" ] && WANT_DATA=yes
  [ "${OURS_UNINSTALL_DAEMON:-}" = "yes" ] && WANT_DAEMON=yes
elif [ -n "$TTY" ]; then
  hr "1) what to remove"
  PICKED="$(checkbox_select \
    'claude-code=Claude Code plugin (prints manual removal commands)' \
    'codex=Codex plugin' \
    'hermes=Hermes plugin' \
    'openclaw=OpenClaw plugin' \
    'data=ours data directory  ('"$OURS_STATE_DIR"' — identities + keys) [destructive]' \
    'daemon=ours-mcp daemon  (stop + remove service + npm global) [destructive]')"
  case " $PICKED " in *" data "*) WANT_DATA=yes;; esac
  case " $PICKED " in *" daemon "*) WANT_DAEMON=yes;; esac
  SELECTED="$(canon_targets "$(printf '%s' "$PICKED" | sed -E 's/\bdata\b|\bdaemon\b//g')")"
else
  say "no terminal and no OURS_UNINSTALL* set — nothing to do. Re-run with a terminal, or set"
  say "  OURS_UNINSTALL=\"hermes codex openclaw\" [OURS_UNINSTALL_DATA=yes] [OURS_UNINSTALL_DAEMON=yes]"
  exit 0
fi

SELECTED="$(printf '%s' "$SELECTED" | sed -E 's/^ +| +$//g')"
if [ -z "$SELECTED" ] && [ "$WANT_DATA" != "yes" ] && [ "$WANT_DAEMON" != "yes" ]; then
  hr "Done"; say "Nothing selected — nothing removed."; exit 0
fi

# --- 2) remove selected harness plugins -------------------------------------------------------
REMOVED=""
KILL_WATCHER=no
for h in $SELECTED; do
  case "$h" in
    hermes)      remove_hermes; KILL_WATCHER=yes; REMOVED="$REMOVED hermes";;
    openclaw)    remove_openclaw; KILL_WATCHER=yes; REMOVED="$REMOVED openclaw";;
    codex)       remove_codex; REMOVED="$REMOVED codex";;
    claude-code) remove_claude_code; REMOVED="$REMOVED claude-code";;
  esac
done
# Stop any reactivity watcher we started (only when a reactive harness was removed).
if [ "$KILL_WATCHER" = "yes" ]; then
  if pkill -f 'connector-watch.sh' 2>/dev/null; then say "stopped the ours reactivity watcher(s)."; fi
fi

# --- 3) data directory (destructive, guarded) -------------------------------------------------
if [ "$WANT_DATA" = "yes" ]; then
  hr "→ ours data directory"
  say "This holds your ours IDENTITIES and private KEYS ($OURS_STATE_DIR). Removing it is permanent"
  say "and cannot be undone — you would lose those identities."
  if [ -n "${OURS_ASSUME_YES:-}" ] || confirm_destructive "the ours data directory ($OURS_STATE_DIR)"; then
    rm_dir "$OURS_STATE_DIR"; REMOVED="$REMOVED data-dir"
  else
    say "  kept the data directory."
  fi
fi

# --- 4) daemon (guarded) ----------------------------------------------------------------------
if [ "$WANT_DAEMON" = "yes" ]; then
  hr "→ ours-mcp daemon"
  if [ -n "${OURS_ASSUME_YES:-}" ] || confirm_destructive "the ours-mcp daemon (stops it + removes its service + npm global)"; then
    if command -v ours-mcp >/dev/null 2>&1; then
      ours-mcp stop 2>/dev/null && say "  stopped the daemon." || say "  daemon was not running."
      ours-mcp uninstall-service 2>/dev/null && say "  removed the persistent service." || say "  no persistent service to remove."
    fi
    "$NPM" rm -g @ours.network/mcp 2>/dev/null && say "  npm: removed @ours.network/mcp" || say "  npm: @ours.network/mcp not installed globally (skipped)"
    REMOVED="$REMOVED daemon"
  else
    say "  kept the daemon."
  fi
fi

# --- done -------------------------------------------------------------------------------------
hr "Done"
if [ -n "$REMOVED" ]; then
  say "removed:"; for r in $REMOVED; do say "  ✓ $r"; done
else
  say "nothing was removed."
fi
[ "$WANT_DATA" != "yes" ] && say "Your ours identities/keys in $OURS_STATE_DIR were left in place."
say "Reload each harness to drop the ours tools (Hermes/OpenClaw: '/reload-mcp' / 'openclaw gateway restart'; Codex: next session)."
