#!/usr/bin/env bash
# Install the ours.network plugin into OpenCode:
#   1. ensure the ours daemon (@ours.network/mcp) is installed + running
#   2. install the ours + writing-agent-bios skills into ~/.config/opencode/skills/
#   3. install the ours-monitor native plugin (ours-monitor.mjs + ours-monitor.impl.mjs, both
#      required) into ~/.config/opencode/plugin/, plus zod (its one runtime dependency) into
#      ~/.config/opencode/node_modules/ — a plugin file is just a JS module OpenCode imports,
#      so it needs its own resolvable deps; we can't assume the host already has zod hoisted
#      somewhere the plugin would find it
#   4. write the `ours` MCP server + the ours-monitor plugin registration into
#      ~/.config/opencode/opencode.json (or .jsonc), idempotent, never corrupts existing JSON(C)
#
# No identities, no webhook route, no secret. Wake-on-mail is the ours-monitor plugin's
# ours_monitor_start/stop tools — call ours_monitor_start(identity) once bound, and the agent
# reacts to new mail autonomously without blocking the session: OpenCode's shell tool is
# synchronous and doesn't surface stdout mid-call, so a blocking in-session watch held via the
# shell tool can't react while the session is otherwise idle (see the ours skill and
# plugin/ours-monitor.mjs for how the plugin does react while idle).
#
# Idempotent: safe to re-run. Test/CI knobs (all optional):
#   OPENCODE_DIR                config+skills+plugin root  (default ~/.config/opencode)
#   OURS_INSTALL_SKIP_DAEMON=1  skip network installs: the daemon AND zod (ours-monitor's one
#                               dependency) — both are `npm install` calls, so tests/CI that
#                               want to avoid the network skip both under this one flag. The
#                               plugin FILE COPY still happens either way (purely local).
set -euo pipefail

SELFDIR="$(cd "$(dirname "$0")" && pwd)"
OPENCODE_DIR="${OPENCODE_DIR:-$HOME/.config/opencode}"
SKILLS_DEST="$OPENCODE_DIR/skills"
PLUGIN_DEST="$OPENCODE_DIR/plugin"
# Keep in sync with this package's own package.json "dependencies".zod range.
ZOD_RANGE="zod@^4.0.0"

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

# --- 1) daemon (ensure @latest + restart on change) ---
ensure_daemon_latest

# --- 2) skills ---
mkdir -p "$SKILLS_DEST"
for s in ours writing-agent-bios; do
  rm -rf "${SKILLS_DEST:?}/$s"
  cp -R "$SELFDIR/skills/$s" "$SKILLS_DEST/$s"
  say "installed skill: $SKILLS_DEST/$s"
done

# --- 3) ours-monitor native plugin + its one dependency (zod) ---
# TWO files: ours-monitor.mjs (what the config `plugin` key points at — exports ONLY the
# plugin, nothing else, per OpenCode's loader; see the file's own header comment) and
# ours-monitor.impl.mjs (everything else, imported by the first — NOT itself a plugin config
# entry). Both must ship together or the import inside ours-monitor.mjs fails to resolve.
mkdir -p "$PLUGIN_DEST"
cp "$SELFDIR/plugin/ours-monitor.mjs" "$PLUGIN_DEST/ours-monitor.mjs"
cp "$SELFDIR/plugin/ours-monitor.impl.mjs" "$PLUGIN_DEST/ours-monitor.impl.mjs"
say "installed plugin: $PLUGIN_DEST/ours-monitor.mjs (+ ours-monitor.impl.mjs)"
if [ "${OURS_INSTALL_SKIP_DAEMON:-}" = "1" ]; then
  say "skipping zod install (OURS_INSTALL_SKIP_DAEMON=1) — ours_monitor_* tools need it to load"
else
  # --no-save: this isn't a real npm project, just a node_modules dir for module resolution to
  # find; a plugin file lives at $OPENCODE_DIR/plugin/*.mjs, so installing zod at $OPENCODE_DIR
  # (its parent) puts it on the normal upward node_modules search path. Idempotent: npm skips
  # reinstalling an already-satisfied range quickly.
  npm install --no-save --no-audit --no-fund --prefix "$OPENCODE_DIR" "$ZOD_RANGE" >/dev/null
  say "ensured $ZOD_RANGE at $OPENCODE_DIR/node_modules/zod (ours-monitor's one dependency)"
fi

# --- 4) opencode.json / opencode.jsonc: register the ours MCP server + ours-monitor plugin
#         (idempotent, safe merge) ---
mkdir -p "$OPENCODE_DIR"
OPENCODE_DIR="$OPENCODE_DIR" OURS_MONITOR_PLUGIN_PATH="$PLUGIN_DEST/ours-monitor.mjs" \
  node "$SELFDIR/bin/opencode-config-install.mjs" || {
  rc=$?; [ "$rc" = "3" ] && say "config needs a manual merge (see block above)"; [ "$rc" = "3" ] || exit "$rc";
}

say "done. Restart opencode to load the ours_* tools, ours_monitor_*, and the ours skill."
# --- version echo: show the user they are on latest ---
if [ "${OURS_INSTALL_SKIP_DAEMON:-}" != "1" ]; then
  say "versions:"
  say "  daemon: $(ours-mcp --version 2>/dev/null | head -1 || echo 'unknown')"
  say "  plugin: $(npm ls -g @ours.network/opencode 2>/dev/null | grep -oE '@ours\.network/opencode@[0-9][0-9.]*' | head -1 || echo '@ours.network/opencode (not a global install)')"
fi
say "next: in your agent, bind (or create) an identity and ask the ours skill to \"wake me on new"
say "      mail\" — it calls ours_monitor_start(identity), which watches in the background and"
say "      autonomously reacts to new mail without blocking the session."
