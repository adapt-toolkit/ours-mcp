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
   Windows prints a WSL pointer and exits), Node.js, and **harness detection with alias-safety**.
   Before ever calling `claude` / `codex`, it confirms each resolves to a **real executable** that
   answers `--version` promptly. A shell alias / hanging wrapper is **never called** (that would
   hang the run) — it's reported plainly with a fix, and a manual-install path is always offered.
   If neither harness exists it says so and exits.
2. **Five consent gates**, each paced with a clean `✓ … No problems.` line + an explicit
   **Continue?** — never a start-twice-then-ask, never a silent failure:
   - **1/5 the shared ours daemon** — its own step, before every consumer, and it owns its own
     configuration: the **broker** (end-to-end encrypted; the broker never sees message content —
     almost everyone just presses Enter) and the **listen port**, which is now an explicit
     question rather than one you only hear about when `3050` is busy. The default is still
     `3050` (the next free port when that is taken), so **Enter and every non-interactive run
     land exactly where they always did**. The answer is validated (a real port, not reserved by
     another component, not already in use, not already claimed by another daemon in this run),
     persisted to `~/.ours/config.json`, and it is the endpoint everything below is wired to.
     Then: write config → optional voice setup → install/start ONCE → boot service. On a re-run
     it reuses the running config (no re-ask) and only updates when you say yes. Complete voice
     setup is kept without prompting. Missing/incomplete setup is offered before the first start
     or pending update restart, then delegated to the canonical `ours-mcp voice-setup` provider
     selector and hidden API-key prompt. Accepted setup owns the one restart/readiness
     transaction; declining or already-ready setup preserves the normal core lifecycle. The
     secret is written atomically to mode-`0600` config; a failed daemon reload rolls back.
   - **2/5 harness plugins** — the installer **drives the plugin CLIs itself**
     (`claude plugin marketplace add …` + `claude plugin install ours@ours.network`;
     `codex plugin marketplace add …` + `codex plugin add ours@ours-codex-marketplace`). Choosing
     Codex also installs the `ours-codex` live launcher in the same step. Any failure / alias
     prints the exact manual commands and continues — it **never dead-ends**.
   - **3/5 ours-fleet** — makes your harnesses persistent, always-online agent teams that survive
     a reboot; runs `ours-fleet init`. Default **Yes**.
   - **4/5 Telegram connector** — install-only (no bot tokens here), then a question asked
     **independently of every other consumer**: use the shared daemon from step 1, or run against
     its **own dedicated daemon**? Default (and Enter, and non-interactive) is the shared one.
     A dedicated daemon is provisioned with its own port, its own state directory
     (`~/.ours-tg`) and its own boot unit (`ours-tg.service`), and the connector is wired to
     that endpoint. Then optionally installed as a boot service itself.
   - **5/5 Rooms (ours-cowork)** — durable mission rooms. Default **No**. `ours-cowork` is a
     **standalone** daemon that consumes no ours daemon at all, so what this step configures is
     what its config actually has: the deployment's broker, its own state directory
     (`~/.ours-cowork`) and its loopback **console port** (default `3052`, validated the same
     way). Then `ours-cowork install-service`.
3. **Summary + hand-off** — a recap (skipped/failed rows call out the fix), then a **literal
   copy-paste prompt** (human identity + fleet + Telegram + Rooms) with the steps for any
   skipped/failed component dropped out. Copied to the clipboard where supported.

The human identity is created idempotently after the daemon becomes reachable. Because
`curl … | bash` gives the script its input over the pipe, every prompt is read from the
controlling terminal (`/dev/tty`), so the flow still works piped.

## Daemon topology

A clean deployment installs, configures and starts **one shared** ours daemon first, then wires
every client to that same daemon. That is the default and the backward-compatible answer.

**Optional isolation.** The Telegram connector may instead be given its own daemon, chosen
independently of everything else. Isolation is only real when all three of these are separate,
which is what the installer provisions:

| | shared | dedicated (Telegram) |
|---|---|---|
| listen port | your step-1 answer | its own, validated against every other daemon in the run |
| state directory | `~/.ours` | `~/.ours-tg` — the daemon's API token lives here |
| boot unit | `ours.service` | `ours-tg.service` (via `OURS_SERVICE_NAME`) |
| config file | `~/.ours/config.json` | `~/.ours-tg/config.json` |

Without a distinct service name, `ours-mcp install-service` would write the **same** unit for
both and the second daemon would silently overwrite the first's port and state directory. See
`packages/core/src/service-instance.ts`; a daemon with no instance name keeps exactly the
historical `ours.service` / `solutions.adaptframework.ours`.

**Rooms is different.** `ours-cowork` is a standalone daemon: it has no `daemonUrl` /
`daemonStateDir` / `/api/v1` surface anywhere in its shipped bundle and its own docs state it
"has no dependency on another agent daemon" — it meets other identities at the **broker**, just
as the ours daemon does. So there is no shared-vs-dedicated ours-daemon question to ask for
Rooms; offering one would configure nothing. What it gets instead is the deployment's broker, its
own state directory, and its own console port.

What wiring a client to a daemon takes differs per client:

- **The harness plugins** need nothing extra: each is `ours-mcp proxy`, which reads the daemon's
  own config (`OURS_CONFIG`, else `~/.ours/config.json`). `autoStart` is off by default, so a proxy
  whose daemon is down reports it rather than quietly starting a second one.
- **The Telegram connector keeps its own config file** and never inherits the daemon's, so the
  installer writes `~/.ours-telegram/config.json` (honouring `OURS_TG_CONFIG`) **before** the
  connector is started or installed as a service — `install-service` bakes whatever it resolves
  into the service unit as environment variables, and those outrank the file from then on.
  Three keys are written, so whichever connector generation is installed finds what it reads:
  - `daemonUrl` + `daemonStateDir` — for `>=0.3.3-nightly.1`, which attaches to the running daemon
    over `/api/v1`. **Both** are required: with neither, its SDK never reads `~/.ours/config.json`
    and falls back to the built-in `127.0.0.1:3050`, missing a daemon on any other port; with the
    endpoint alone it refuses outright (`INCOHERENT_SELECTION` — the daemon's API token belongs to
    a state directory, so selecting an endpoint without one would disclose that token).
  - `brokerUrl` — for `<=0.3.2`, which hosts its own ADAPT wrapper and meets the daemon at a broker
    instead. It must match the daemon's or the two can never see each other.

  A re-run that changes nothing rewrites nothing, and keys the installer does not own are preserved.

If `ours-mcp install-service` fails (no systemd user bus, no linger, a container, WSL without
systemd) it has already **stopped** the daemon it was about to supervise. The installer restarts it
and says plainly that the boot service is missing — a clean deployment never ends with no daemon
while the summary claims success.

## Release channel

`OURS_CHANNEL=nightly` (or `OURS_INSTALL_CHANNEL`) installs each package's **own** prerelease
dist-tag. The tag is not the same string everywhere, so the mapping is per package:

| package | stable channel | nightly channel |
|---|---|---|
| `mcp`, `tg-connector`, `claude-code`, `codex`, `hermes` | `latest` | `nightly` |
| `fleet` | `latest` | `nightly` |
| `cowork` (Rooms) | `latest` | `latest` — **pinned** |

`fleet` follows the channel: it publishes its own `nightly` dist-tag, and the nightly stack needs
the fleet build carrying the SDK integration. A nightly installer that quietly installed stable
fleet is the same split-brain deployment the channel exists to prevent.

`cowork` is pinned because its prerelease tag is `next`, not `nightly`, **and** `next` is
currently older than `latest` (`0.3.7-nightly.*` vs `0.4.0`) — following it would knowingly
downgrade Rooms. When cowork's `next` catches up, add `{ nightly: 'next' }` for it in
`PKG_CHANNEL_TAGS` (`lib/logic.mjs`); nothing else changes. A package with no mapping for the
selected channel installs `@latest` rather than a guessed tag, because a 404 fails the *whole*
install.

**With no explicit selection the installer follows its own version.** A published nightly build
carries the `-nightly.N` suffix the release bump stamps, so `npm i -g @ours.network/install@nightly`
builds a nightly stack, and a stable installer can never consume a nightly. This is load-bearing
rather than cosmetic: across `tg-connector` 0.3.2 → 0.3.3-nightly.1 the connector stopped hosting
its own ADAPT wrapper and became a client of the shared daemon, so mixing tags across that boundary
pairs a connector that needs `/api/v1` with a daemon that does not serve it. `OURS_CHANNEL` still
overrides in both directions.

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
| `OURS_STATE_DIR` | daemon state directory (default `~/.ours`) — also what the Telegram connector is told to expect |
| `OURS_TG_CONFIG` | Telegram connector config file location (default `~/.ours-telegram/config.json`) |
| `OURS_COWORK_CONFIG` | Rooms config file location (default `~/.ours-cowork/config.json`) |
| `OURS_CHANNEL` | `nightly` or `latest`; unset follows the installer's own version |

A non-interactive run takes the shared daemon on its existing default port and installs no
dedicated daemon and no Rooms — the topology is unchanged from before this flow existed.

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
  plugins via each marketplace, `@ours.network/fleet`, `@ours.network/tg-connector`, and
  `@ours.network/cowork` — are the published components.
- **Idempotent + safe to re-run.** A re-run adds a skipped piece, re-points the plugins, or (only
  when you say yes) updates a component; an already-current daemon is left untouched, its running
  port and complete voice setup are reused everywhere — and the Telegram connector's daemon
  selection, a dedicated daemon's config, and the Rooms config are each rewritten only if they
  actually changed. Bot tokens and fleet roles remain in the copy-paste hand-off; provider keys
  never enter that prompt or agent chat.
