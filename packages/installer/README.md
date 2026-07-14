# @ours.network/installer

The one-shot **ours.network** installer — a friendly, guided setup that is the capstone over
the per-harness plugin installers. Hosted on git and meant to be run as:

```sh
curl -fsSL https://raw.githubusercontent.com/adapt-toolkit/ours-mcp/main/packages/installer/install.sh | bash
```

(A short `https://ours.network/install.sh` redirect to the same file is a future optional
convenience — the git raw URL above is the canonical source.)

`install.sh` is a **thin bootstrap**: it checks that Node.js (≥ 20) is present — printing
friendly, per-OS guidance if it isn't — then hands off to a **Node installer** (`install.mjs`)
that provides the real experience: an ASCII banner, tasteful colour (degrades under `NO_COLOR`
/ no-tty), and plain-language explanations of **what** each step does and **why**.

It:

1. installs and starts the ours daemon (`@ours.network/mcp`) — ensuring `@latest` and
   restarting it only when the version actually changed;
2. offers to install the daemon as a **persistent service** (survives reboot,
   `ours-mcp install-service`);
3. lets you set the **broker address** (the relay your node dials to reach peers — keep the
   default unless you run your own) and the **HTTP port** (default `3050`, with conflict
   handling that never hands out `3051`, reserved for the Telegram connector);
4. lets you **toggle** which agent harnesses to set up — **Claude Code**, **Codex**,
   **Hermes** — via a checkbox picker (arrow keys move, **space** toggles, **enter** confirms)
   and runs each selected harness's plugin installer;
5. does everything in one pass — no "now do X, now press start" follow-up — and prints the
   installed **versions** plus a brief "how to use" recap at the end.

The base install asks **zero** identity/wake questions. For Codex it installs the native
plugin (skills, MCP servers, and hooks) plus the global `ours-codex` launcher. Standard
mode starts with `codex`; live mode starts with `ours-codex`. Live monitoring is armed
only after the user explicitly approves it for the currently bound identity, and stops
with that CLI session.

Because `curl … | bash` gives the script its input over the pipe, every interactive prompt is
read from the controlling terminal (`/dev/tty`), so the picker still works.

## Per-harness installs still work standalone

The unified installer just orchestrates the same per-harness packages you can install
directly (each is exactly two commands):

| harness | commands |
|---|---|
| Hermes | `npm i -g @ours.network/hermes` · `ours-hermes-install` |
| Codex | `npm i -g @ours.network/codex` · `ours-codex-install` |
| Claude Code | `/plugin marketplace add adapt-toolkit/ours-claude-marketplace` · `/plugin install ours` (in-app) |

Claude Code installs from its in-app marketplace rather than a shell bin, so the unified
installer sets up the daemon and prints those two in-Claude-Code commands.

## Non-interactive / CI

When there is no terminal (headless), drive it with environment variables:

```sh
OURS_HARNESSES="codex hermes" \
OURS_SERVICE=no \
OURS_ASSUME_YES=1 \
  bash install.sh
```

| var | meaning |
|---|---|
| `OURS_HARNESSES` | harnesses to set up (space/comma list of `claude-code codex hermes`, or `all`) |
| `OURS_SERVICE` | `yes`/`no` — install the daemon as a persistent service |
| `OURS_BROKER` | broker address to write (default: keep the daemon's current) |
| `OURS_PORT` | daemon HTTP port to write (default: keep the daemon's current; never `3051`) |
| `OURS_ASSUME_YES` | accept defaults, never prompt |
| `OURS_NPM` | npm binary to use (default `npm`) |
| `OURS_CODEX_LIVE` | `yes` reports the `ours-codex` live path; `no` reports standard mode |

## Uninstall

The companion `uninstall.sh` reverses what the installers created — same thin-bootstrap +
Node treatment (banner, colour, a clear explanation of what will be removed). Run it from a
checkout:

```sh
bash packages/installer/uninstall.sh
```

or over the same raw-URL pattern as `install.sh` (pointing at `uninstall.sh`):

```sh
curl -fsSL https://raw.githubusercontent.com/adapt-toolkit/ours-mcp/main/packages/installer/uninstall.sh | bash
```

It uses the **same toggle UI** to pick what to remove — per-harness plugins, the ours data
directory (`~/.ours`), and the `ours-mcp` daemon. It removes **only** what the installers
created, and guards the two destructive items — the data directory and the daemon — behind
an explicit typed `yes`.

Headless (no terminal), drive it with environment variables:

```sh
OURS_UNINSTALL="hermes codex" \
OURS_UNINSTALL_DATA=yes \
OURS_UNINSTALL_DAEMON=yes \
  bash uninstall.sh
```

| var | meaning |
|---|---|
| `OURS_UNINSTALL` | harnesses to remove (space/comma list of `claude-code codex hermes`, or `all`) |
| `OURS_UNINSTALL_DATA` | `yes` — remove the ours data directory (`~/.ours`) |
| `OURS_UNINSTALL_DAEMON` | `yes` — remove the `ours-mcp` daemon |

## Notes

- This package is **not published to npm** (`private: true`); it ships as the hosted
  `install.sh` bootstrap plus the `install.mjs` Node installer (and its `lib/`). The harness
  packages it installs (`@ours.network/{hermes,codex}`) and the daemon (`@ours.network/mcp`)
  are the published pieces.
- Idempotent end to end: re-running upgrades the daemon + plugins to `@latest`, restarts the
  daemon only on a version/config change, and each per-harness installer is itself idempotent.
