# @ours.network/install — `ours-install`

The **unified ours.network stack installer**. ONE guided ~3-minute flow that installs the WHOLE
stack for someone who already has Claude Code, Codex, and/or Hermes, safely offers optional
voice-message transcription, then hands back a single copy-paste prompt for remaining setup.

## Install

**Recommended — a persistent, versioned, integrity-checked command on your PATH:**

```sh
npm i -g @ours.network/install && ours-install
```

Re-run (or update / add a skipped piece) any time with just `ours-install`.

**One-off, no global install:**

```sh
npx @ours.network/install
```

**Fallback for machines without npm** (least secure — pipes a script straight into your shell):

```sh
curl -fsSL https://raw.githubusercontent.com/adapt-toolkit/ours-mcp/main/packages/installer/install.sh | bash
```

The `curl … | bash` bootstrap simply gets Node.js/npm sorted, then does the `npm i -g
@ours.network/install` and runs `ours-install` for you. `ours-install` is the single front door;
`ours-codex-install` is kept as a **thin alias** that hands off to it (use
`ours-codex-install --codex-only` for the legacy Codex-only path).

The installer is a small **self-contained** Node package (Node built-ins only — no runtime
dependency on the things it installs): an ASCII banner, tasteful colour (degrades under `NO_COLOR`
/ no-tty), and plain-language **what + why** for every step.

## The flow (what the user sees)

1. **Pre-flight** — a short checklist, not a wall of logs: platform (Linux / macOS / WSL; native
   Windows prints a WSL pointer and stops), and Node.js (v20+). No harness is required: the
   daemon is the product, and a machine with no Claude Code / Codex / Hermes still gets one.
2. **The daemon (§§2-4)** — a daemon is identified by its **state directory**, not by its port.
   `--state-dir` is the key (default `~/.ours`); a second state directory is a second daemon.
   The port is taken from whatever daemon already owns that directory, and is only searched —
   from 3050 upward, skipping other components' defaults — when this run CREATES one. A `--port`
   that disagrees with the port an existing daemon is really on is **refused** (exit 2, nothing
   written) rather than quietly corrected. Then: install `@ours.network/cli`, merge the config
   (never rewrite it), start the daemon, and install its **per-instance** boot service via
   `ours daemon install-service`, which owns the marker check — the installer never touches a
   unit file or `systemctl` itself.
   On a first install the **broker** question is asked once (end-to-end encrypted; the broker
   never sees message content — almost everyone just presses Enter).
3. **Components (§5)** — the MCP server (default yes), the Telegram connector and cowork
   (default no). None of them IS the daemon; all three attach to one. `ours-mcp` runs per
   session as a stdio proxy and gets **no unit**. A component that fails is reported with its
   retry command and the run continues.
4. **Your human identity** — `ours-mcp create-root`, run against THIS daemon. Already-exists is
   a friendly keep; an unreachable daemon gets the exact retry command.
5. **Harness plugins** — the installer **drives the plugin CLIs itself**
   (`claude plugin marketplace add …` + `claude plugin install ours@ours.network`;
   `codex plugin marketplace add …` + `codex plugin add ours@ours-codex-marketplace`; Hermes via
   `npm` + `ours-hermes-install --skip-daemon`). Choosing Codex also installs the `ours-codex`
   live launcher in the same step. An alias, a wrapper that will not answer `--version`, or any
   failure prints the exact manual commands and continues — it **never dead-ends**.
   For a **non-default state directory**: Hermes' config block carries `OURS_CONFIG`, so its pair
   is real. Claude Code's and Codex's registrations cannot carry a value at all, so the installer
   prints the exact `export OURS_CONFIG=…` line and claims nothing.
6. **ours-fleet** — makes your harnesses persistent, always-online agent teams that survive a
   reboot; runs `ours-fleet init`. Default **Yes**. The installer configures nothing inside
   fleet — fleet already resolves a daemon per role — but for a non-default state directory it
   tells you the one `env: { OURS_CONFIG: … }` line your `fleet.yaml` roles need.
7. **Voice messages** — offered after the components, because it is an `ours-mcp` subcommand and
   `ours-mcp` is a component. Credentials are delegated entirely to the canonical
   `ours-mcp voice-setup` (provider selector, hidden API key, atomic mode-`0600` write); the
   installer keeps no second implementation. Under v3 that command classifies every daemon as
   `external` and writes config only, so **the installer performs the restart and the readiness
   check** — `ours daemon restart --config <state-dir>/config.json`. Declining is clean and is
   offered again on the next run.
8. **Summary + hand-off** — a recap (skipped/failed rows call out the fix), then a **literal
   copy-paste prompt** with the steps for any skipped/failed piece dropped out. For a non-default
   state directory the prompt opens by telling your agent which `OURS_CONFIG` to use. Copied to
   the clipboard where supported.

Because `curl … | bash` gives the script its input over the pipe, every prompt is read from the
controlling terminal (`/dev/tty`), so the flow still works piped.

## Removing a daemon

```sh
ours-uninstall [--state-dir PATH] [--purge] [--dry-run]
```

Symmetric with the installer and keyed the same way. It refuses **before removing anything** if a
component still points at that daemon, removes the unit through `ours daemon uninstall-service`
(which refuses a unit it did not mark), and removes the global packages **only** when no other
state directory on the machine still has a daemon config. `--purge` deletes the state directory
itself: never a default, never non-interactive, refused for a directory with no ours state
markers at all, and it asks you to **type the full path** — those identity keys exist nowhere
else and no peer can give them back.

When it is the last daemon on the machine it also removes the harness plugins the installer
wrote: the ours **managed block** from `~/.hermes/config.yaml`, `~/.codex/config.toml` and
`~/.codex/AGENTS.md`, the ours **skills directories**, and the plugin launchers on npm. It edits a
config file only when it finds **both** of our sentinels — a block with no closing marker is
reported and left alone rather than truncated to end of file — and every path it removes is exact,
never a glob. Claude Code's plugin lives in its in-app marketplace, so the run prints
`/plugin uninstall ours` and claims nothing. While a second daemon is still present none of this
happens: its harnesses still need those plugins.

## Non-interactive / CI / safe dry-run

```sh
OURS_ASSUME_YES=1 ours-install              # accept every default, no prompts
ours-install --dry-run                      # walk the WHOLE flow, install/change NOTHING
ours-install --state-dir ~/.ours-tg         # a SECOND daemon, alongside the first
```

`OURS_INSTALL_DRY_RUN=1` routes every side-effecting action through a print-only seam — it shows
exactly the commands it *would* run (npm installs, `ours daemon start`, plugin adds, `ours-fleet
init`, service installs) without executing them. That is the safe way to preview the flow on a
machine you don't want to touch, and how the integration tests drive it.

Non-interactive runs never prompt for or synthesize voice credentials. Supply a complete
`OURS_STT_*` environment configuration yourself, or rerun interactively later; missing setup
is reported and left unchanged.

| var | meaning |
|---|---|
| `OURS_ASSUME_YES` | accept every default, never prompt (implies no tty needed) |
| `OURS_INSTALL_DRY_RUN` | walk the flow without installing or changing anything |
| `OURS_NPM` | npm binary to use (default `npm`) |
| `OURS_CONFIG` | daemon config file location (default `~/.ours/config.json`) |

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
  `install.sh` bootstrap plus the `install.mjs` Node installer (and its `lib/`), and exposes the
  `ours-install` bin. The pieces it installs — the daemon (`@ours.network/mcp`), the harness
  plugins via each marketplace, `@ours.network/fleet`, and `@ours.network/tg-connector` — are the
  published components.
- **Idempotent + safe to re-run.** A re-run adds a skipped piece, re-points the plugins, or (only
  when you say yes) updates a component; an already-current daemon is left untouched, its running
  port and complete voice setup are reused everywhere. Bot tokens and fleet roles remain in the
  copy-paste hand-off; provider keys never enter that prompt or agent chat.
