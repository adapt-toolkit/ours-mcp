#!/usr/bin/env bash
# Install the ours.network plugin into OpenClaw:
#   1. ensure the ours daemon (@ours.network/mcp) is installed + running
#   2. install the ours + writing-agent-bios skills into ~/.openclaw/skills/
#   3. write the `ours` MCP server (mcp.servers.ours) into ~/.openclaw/openclaw.json
#      (idempotent; never clobbers an existing JSON5 config)
#
# That's it — no identities, no webhook route, no bearer token, no gateway .env, no watcher.
# Wake-on-mail is the agent tailing `ours-mcp watch <identity>` IN-SESSION (see the ours skill),
# exactly like Claude Code.
#
# Idempotent: safe to re-run. Test/CI knobs (all optional):
#   OPENCLAW_DIR               config+skills root         (default ~/.openclaw)
#   OURS_INSTALL_SKIP_DAEMON=1 skip daemon install/start
set -euo pipefail

SELFDIR="$(cd "$(dirname "$0")" && pwd)"
OPENCLAW_DIR="${OPENCLAW_DIR:-$HOME/.openclaw}"
OPENCLAW_CONFIG="$OPENCLAW_DIR/openclaw.json"
SKILLS_DEST="$OPENCLAW_DIR/skills"
# ~/.agents/skills OUTRANKS ~/.openclaw/skills in OpenClaw's scan order (see shadow refresh below).
AGENTS_SKILLS="${AGENTS_SKILLS:-$HOME/.agents/skills}"

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

# Idempotent, GUARDED cleanup of legacy connector-era artifacts earlier (0.2.0/0.3.0) installers
# wrote. Removes ONLY those exact artifacts — never user files.
legacy_cleanup(){
  local f tmp
  for f in "$OPENCLAW_DIR/ours-connector.env" "$OPENCLAW_DIR/ours-connector.log"; do
    [ -f "$f" ] && rm -f "$f" && say "removed legacy connector artifact: $f"
  done
  # Per-identity watcher logs/pidfiles the old installer wrote (explicit prefix globs in OUR dir).
  for f in "$OPENCLAW_DIR"/ours-connector-*.log "$OPENCLAW_DIR"/ours-watch-*.pid; do
    [ -e "$f" ] && rm -f "$f" && say "removed legacy connector artifact: $f"
  done
  pkill -f 'connector-watch.sh' 2>/dev/null && say "stopped a leftover connector watcher" || true
  # Drop ONLY our OURS_WAKE_SECRET line from the gateway dotenv; keep everything else the user has.
  if [ -f "$OPENCLAW_DIR/.env" ] && grep -q '^OURS_WAKE_SECRET=' "$OPENCLAW_DIR/.env" 2>/dev/null; then
    tmp="$(mktemp "$OPENCLAW_DIR/.env.XXXXXX")"
    grep -v '^OURS_WAKE_SECRET=' "$OPENCLAW_DIR/.env" > "$tmp" || true
    mv "$tmp" "$OPENCLAW_DIR/.env" && say "removed legacy OURS_WAKE_SECRET from $OPENCLAW_DIR/.env"
  fi
  # Remove the legacy connector-era bits from openclaw.json — the ours-wake* webhook routes AND
  # the `//ours` ROOT marker an old installer stamped (OpenClaw's strict schema rejects it:
  # `openclaw doctor` → "Unrecognized key: //ours"). Keep mcp.servers.ours (the current block)
  # intact. Strict-JSON only — a JSON5/comment config is left untouched (handled by config-install).
  if [ -f "$OPENCLAW_CONFIG" ]; then
    node -e '
      const fs=require("fs"); const f=process.argv[1];
      let raw; try{raw=fs.readFileSync(f,"utf8");}catch{process.exit(0);}
      let cfg; try{cfg=JSON.parse(raw);}catch{process.exit(0);}
      let changed=false;
      if(cfg&&typeof cfg==="object"&&Object.prototype.hasOwnProperty.call(cfg,"//ours")){delete cfg["//ours"];changed=true;}
      const w=cfg.plugins&&cfg.plugins.entries&&cfg.plugins.entries.webhooks;
      const routes=w&&w.config&&w.config.routes;
      if(routes&&typeof routes==="object"){
        for(const k of Object.keys(routes)) if(k.indexOf("ours-wake")===0){delete routes[k];changed=true;}
      }
      if(changed){fs.writeFileSync(f,JSON.stringify(cfg,null,2)+"\n");console.log("ours-install: healed legacy openclaw.json (removed //ours marker and/or ours-wake route(s)) in "+f);}
    ' "$OPENCLAW_CONFIG" || true
  fi
}

# Refresh a STALE, higher-precedence copy of our skills so the WINNING copy is current.
# OpenClaw scans (high→low): workspace/skills, workspace/.agents/skills, ~/.agents/skills,
# ~/.openclaw/skills, bundled, extraDirs. So a copy in ~/.agents/skills (where the ours CODEX
# plugin installs, or an old install left one) SHADOWS the fresh copy we just wrote to
# ~/.openclaw/skills. We only touch it when it is BOTH ours (contains "ours.network") AND stale
# (a connector-era skill — current skills never mention "connector"). A CURRENT co-installed
# Codex copy has no "connector" marker, so it is left untouched; and we never delete (that path
# belongs to a co-installed Codex plugin) nor create it (never claim a path we do not own).
refresh_shadowing_skills(){
  local s dst
  for s in ours writing-agent-bios; do
    dst="$AGENTS_SKILLS/$s"
    if [ -f "$dst/SKILL.md" ] \
       && grep -qi 'ours\.network' "$dst/SKILL.md" 2>/dev/null \
       && grep -qi 'connector' "$dst/SKILL.md" 2>/dev/null; then
      rm -rf "${dst:?}"
      cp -R "$SELFDIR/skills/$s" "$dst"
      say "refreshed a stale connector-era skill copy that outranks ~/.openclaw/skills: $dst"
    fi
  done
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

# --- 2b) refresh any stale higher-precedence (~/.agents/skills) copy that would shadow ours ---
refresh_shadowing_skills

# --- 3) openclaw.json: register the ours MCP server (idempotent, safe merge) ---
mkdir -p "$OPENCLAW_DIR"
OPENCLAW_CONFIG="$OPENCLAW_CONFIG" node "$SELFDIR/bin/openclaw-config-install.mjs" || {
  rc=$?; [ "$rc" = "3" ] && say "config needs a manual merge (see block above)"; [ "$rc" = "3" ] || exit "$rc";
}

say "done. Run \`openclaw gateway restart\` to load the ours MCP tools."
# --- version echo: show the user they are on latest ---
if [ "${OURS_INSTALL_SKIP_DAEMON:-}" != "1" ]; then
  say "versions:"
  say "  daemon: $(ours-mcp --version 2>/dev/null | head -1 || echo 'unknown')"
  say "  plugin: $(npm ls -g @ours.network/openclaw 2>/dev/null | grep -oE '@ours\.network/openclaw@[0-9][0-9.]*' | head -1 || echo '@ours.network/openclaw (not a global install)')"
fi
say "next: in your agent, bind (or create) an identity and ask the ours skill to \"wake me on new"
say "      mail\" — it tails ours-mcp watch in-session and reacts to new mail as it arrives."
