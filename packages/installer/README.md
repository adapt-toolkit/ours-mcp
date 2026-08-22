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

### Stable and nightly channels

The installer package selects the channel for the stack it installs. No extra environment
variable is required:

```sh
# Stable (the default)
npm i -g @ours.network/install@latest && ours-install

# Nightly
npm i -g @ours.network/install@nightly && ours-install
```

A clean `X.Y.Z` installer resolves the `latest` dist-tags; an
`X.Y.Z-nightly.N` installer resolves the `nightly` dist-tags. Before changing the machine,
`ours-install` resolves `@ours.network/mcp`, `@ours.network/claude-code`, and
`@ours.network/codex`, validates that npm returned exact versions from the selected channel,
and requires all three to be the same lockstep version. It then installs MCP and the Codex
launcher by exact version and generates exact-version local marketplace sources for Claude Code
and Codex under `~/.ours/install/marketplaces/`. A moving `latest` or `nightly` selector is never
left in a plugin installation source after resolution.

Existing automation may still set `OURS_CHANNEL=latest|nightly` (or the legacy
`OURS_INSTALL_CHANNEL`) explicitly; that override continues to win. With no override, stable is
still the safe default for a local checkout or an unreadable package version.

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
   Windows prints a WSL pointer and exits), Node.js, and **harness detection with alias-safety**.
   Before ever calling `claude` / `codex`, it confirms each resolves to a **real executable** that
   answers `--version` promptly. A shell alias / hanging wrapper is **never called** (that would
   hang the run) — it's reported plainly with a fix, and a manual-install path is always offered.
   If neither harness exists it says so and exits.
2. **Config-first** (first install only) — the daemon's two base settings, up front:
   the **broker** (end-to-end encrypted; the broker never sees message content — almost everyone
   just presses Enter) and the **port** (probes `3050`; only asks if it's busy; never hands out
   `3051`, reserved for the Telegram connector). Applied once, then the stack is built with it.
3. **Four consent gates**, each paced with a clean `✓ … No problems.` line + an explicit
   **Continue?** — never a start-twice-then-ask, never a silent failure:
   - **1/4 ours core (the daemon)** — install the exact version resolved for this installer's
     stable/nightly channel → write config → optional voice setup → start ONCE
     → boot service. On a re-run it reuses the running config (no re-ask) and only updates when
     you say yes. Complete voice setup is kept without prompting. Missing/incomplete setup is
     offered before the first start or pending update restart, then delegated to the canonical
     `ours-mcp voice-setup` provider selector and hidden API-key prompt. Accepted setup owns the
     one restart/readiness transaction; declining or already-ready setup preserves the normal
     core lifecycle. The secret is written atomically to mode-`0600` config; a failed daemon
     reload rolls back.
   - **2/4 harness plugins** — the installer **drives the plugin CLIs itself** using generated,
     exact-version local marketplace sources
     (`claude plugin marketplace add …` + `claude plugin install ours@ours.network`;
     `codex plugin marketplace add …` + `codex plugin add ours@ours-codex-marketplace`). Choosing
     Codex also installs the `ours-codex` live launcher in the same step. Any failure / alias
     prints the exact manual commands and continues — it **never dead-ends**.
   - **3/4 ours-fleet** — makes your harnesses persistent, always-online agent teams that survive
     a reboot; runs `ours-fleet init`. Default **Yes**.
   - **4/4 Telegram connector** — install-only (no bot tokens here), then optionally as a
     boot service.
4. **Summary + hand-off** — a recap (skipped/failed rows call out the fix), then a **literal
   copy-paste prompt** (root identity + fleet + Telegram) with the steps for any skipped/failed
   component dropped out. Copied to the clipboard where supported.

The human identity is created idempotently after the daemon becomes reachable. Because
`curl … | bash` gives the script its input over the pipe, every prompt is read from the
controlling terminal (`/dev/tty`), so the flow still works piped.

## Non-interactive / CI / safe dry-run

```sh
OURS_ASSUME_YES=1 bash install.sh          # accept every default, no prompts
OURS_INSTALL_DRY_RUN=1 bash install.sh     # walk the WHOLE flow, install/change NOTHING
```

`OURS_INSTALL_DRY_RUN=1` routes every side-effecting action through a print-only seam — it shows
exactly the commands it *would* run (npm installs, `ours-mcp start`, plugin adds, `ours-fleet
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
| `OURS_CHANNEL` | optional explicit `latest` or `nightly` override; otherwise follows the installer package version |
| `OURS_INSTALL_CHANNEL` | legacy alias for `OURS_CHANNEL` |

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

- This package is published to npm as `@ours.network/install` and exposes the `ours-install` bin.
  It remains self-contained (Node built-ins only). The hosted `install.sh` is the stable/latest
  bootstrap; install `@ours.network/install@nightly` directly for the nightly channel.
- **Idempotent + safe to re-run.** A re-run adds a skipped piece, re-points the plugins, or (only
  when you say yes) updates a component; an already-current daemon is left untouched, its running
  port and complete voice setup are reused everywhere. Bot tokens and fleet roles remain in the
  copy-paste hand-off; provider keys never enter that prompt or agent chat.
