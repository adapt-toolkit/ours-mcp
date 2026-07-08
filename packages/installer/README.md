# @ours.network/installer

The one-shot **ours.network** installer — the capstone over the per-harness plugin
installers. Hosted on git and meant to be run as:

```sh
curl -fsSL https://raw.githubusercontent.com/adapt-toolkit/ours-mcp/main/packages/installer/install.sh | bash
```

(A short `https://ours.network/install.sh` redirect to the same file is a future optional
convenience — the git raw URL above is the canonical source.)

It:

1. installs and starts the ours daemon (`@ours.network/mcp`);
2. offers to install the daemon as a **persistent service** (survives reboot,
   `ours-mcp install-service`);
3. lets you **toggle** which agent harnesses to set up — **Claude Code**, **Codex**,
   **Hermes**, **OpenClaw** — via a checkbox picker (arrow keys move, **space** toggles a
   harness on/off, **enter** confirms) and runs each selected harness's plugin installer;
4. does everything in one pass — no "now do X, now press start" follow-up.

The base install asks **zero** identity/wake questions — it sets up only the daemon plus
each harness's MCP server + skill. Wake-on-mail is enabled later, **in-session**, by asking
the `ours` skill to wake the agent for a bound identity: the agent tails
`ours-mcp watch <identity>` (or polls `get_messages` every ~5s) and reacts while it's live.

Because `curl … | bash` gives the script its input over the pipe, every interactive
prompt is read from the controlling terminal (`/dev/tty`), so the picker still works.

## Per-harness installs still work standalone

The unified installer just orchestrates the same per-harness packages you can install
directly (each is exactly two commands):

| harness | commands |
|---|---|
| Hermes | `npm i -g @ours.network/hermes` · `ours-hermes-install` |
| OpenClaw | `npm i -g @ours.network/openclaw` · `ours-openclaw-install` |
| Codex | `npm i -g @ours.network/codex` · `ours-codex-install` |
| Claude Code | `/plugin marketplace add adapt-toolkit/ours-claude-marketplace` · `/plugin install ours.network` (in-app) |

Claude Code installs from its in-app marketplace rather than a shell bin, so the unified
installer sets up the daemon and prints those two in-Claude-Code commands.

## Non-interactive / CI

When there is no terminal (headless), drive it with environment variables:

```sh
OURS_HARNESSES="codex hermes openclaw" \
OURS_SERVICE=no \
OURS_ASSUME_YES=1 \
  bash install.sh
```

| var | meaning |
|---|---|
| `OURS_HARNESSES` | harnesses to set up (space/comma list of `claude-code codex hermes openclaw`, or `all`) |
| `OURS_SERVICE` | `yes`/`no` — install the daemon as a persistent service |
| `OURS_ASSUME_YES` | accept defaults, never prompt |
| `OURS_NPM` | npm binary to use (default `npm`) |

## Uninstall

The companion `uninstall.sh` reverses what the installers created. Run it from a checkout:

```sh
bash packages/installer/uninstall.sh
```

or over the same raw-URL pattern as `install.sh` (pointing at `uninstall.sh`):

```sh
curl -fsSL https://raw.githubusercontent.com/adapt-toolkit/ours-mcp/main/packages/installer/uninstall.sh | bash
```

It uses the **same toggle UI** (arrow keys move, space toggles, enter confirms) to pick
what to remove — per-harness plugins, the ours data directory (`~/.ours`), and the
`ours-mcp` daemon. It removes **only** what the installers created, and guards the two
destructive items — the data directory and the daemon — behind an explicit typed `yes`.

Headless (no terminal), drive it with environment variables:

```sh
OURS_UNINSTALL="hermes codex openclaw" \
OURS_UNINSTALL_DATA=yes \
OURS_UNINSTALL_DAEMON=yes \
  bash uninstall.sh
```

| var | meaning |
|---|---|
| `OURS_UNINSTALL` | harnesses to remove (space/comma list of `claude-code codex hermes openclaw`, or `all`) |
| `OURS_UNINSTALL_DATA` | `yes` — remove the ours data directory (`~/.ours`) |
| `OURS_UNINSTALL_DAEMON` | `yes` — remove the `ours-mcp` daemon |

## Notes

- This package is **not published to npm** (`private: true`); it ships as the hosted
  `install.sh`. The harness packages it installs (`@ours.network/{hermes,openclaw,codex}`)
  and the daemon (`@ours.network/mcp`) are the published pieces.
- Idempotent end to end: the daemon install is a no-op when present, and each per-harness
  installer is itself idempotent.
