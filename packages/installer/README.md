# @ours.network/install — `ours-install`

The all-in-one installer for the ours.network stack. One run installs and
configures the shared daemon, MCP adapter, cowork, Telegram connector, Fleet,
and plugins for every safely detected agent harness.

```sh
npm install --global @ours.network/install
ours-install
```

### Stable and nightly channels

Installing `@ours.network/install@latest` selects the stable channel; installing
`@ours.network/install@nightly` selects the nightly channel. Before changing the
machine, the installer resolves `@ours.network/mcp`,
`@ours.network/claude-code`, and `@ours.network/codex`, verifies that their
selected dist-tags expose one exact lockstep version, and fails closed if they
do not. MCP and the Codex launcher are installed by exact version, and local
Claude Code and Codex marketplace manifests pin the corresponding plugin
packages to that same version.

`OURS_CHANNEL=latest|nightly` (or the legacy `OURS_INSTALL_CHANNEL`) remains an
explicit override. Without an override, the installed package's own version
selects the channel.

The normal flow uses one daemon at `~/.ours` on port 3050, shows an eight-stage
progress bar, and asks only for information it cannot safely infer (normally the
Human identity's display name). Existing daemon conflicts and moving a Telegram
connector from another daemon still require explicit confirmation.

## What the installer does

- Installs `@ours.network/cli`, `@ours.network/mcp`,
  `@ours.network/tg-connector`, `@ours.network/cowork`, and
  `@ours.network/fleet` on one release channel.
- Configures, starts, and enables the single shared daemon.
- Creates the daemon's Human identity (historically called the root identity),
  or preserves the existing one on a re-run.
- Installs the ours plugin into safely detected Claude Code, Codex, and Hermes
  installations.
- Configures and starts cowork as a durable shim over the shared daemon.
- Configures and starts Telegram as a durable shim over the same daemon.
- Runs Fleet's host initialization and, when `~/fleet.yaml` is absent, writes a
  conservative stopped starter with `FleetCoordinator`, a `fleet-health`
  watchdog, and a ten-minute `coordinator_health` loop. An existing
  `~/fleet.yaml` is never overwritten.

The operator CLI owns daemon configuration, lifecycle, and boot persistence.
The MCP package is only the stdio adapter spawned by agent harnesses; the
installer never asks `ours-mcp` to start a daemon.

Daemon state is temporarily scoped to its package major version. On a same-major
update, the installer refreshes the packages and runs `ours daemon restart`; the
CLI streams structured startup phases until restore is complete instead of
appearing to hang. A different-major update is detected before package
replacement. The installer explains the incompatibility and, only in an
interactive run, offers to stop the CLI-managed daemon, copy the complete state
directory to a timestamped directory under `~/.ours-backups/`, remove the
managed service and old state, then initialize the new major. The default answer is no, and
`OURS_ASSUME_YES` never authorizes this purge.

## What remains stopped

Only Fleet is intentionally not started. Review and activate it when ready:

```sh
# After reviewing ~/fleet.yaml:
ours-fleet doctor
ours-fleet config
ours-fleet up
ours-fleet ls
```

The final installer screen repeats these commands and provides a copy-paste
prompt for Claude Code, Codex, or Hermes. The agent should guide local bot-token
entry without asking the user to paste the secret into chat.

## Preview and automation

```sh
ours-install --dry-run
OURS_ASSUME_YES=1 ours-install
ours-install --state-dir /absolute/path --port 3070
```

Dry-run walks the real plan without writing files, installing packages, starting
processes, or changing services. `OURS_ASSUME_YES=1` uses the OS username for a
new Human identity and asks no ordinary setup questions, but it never bypasses
selection conflicts, connector moves, or destructive safeguards.

A non-default daemon must be selected coherently with a config file or matching
port and state directory. Hermes and the generated Fleet role persist that
selection through `OURS_CONFIG`. Claude Code and Codex plugin registrations
cannot store an environment value; for those harnesses the installer prints the
exact `export OURS_CONFIG=...` line that must be added to the shell profile
before starting the harness. There is no per-application daemon.

## Uninstall

```sh
ours-uninstall --state-dir "$HOME/.ours"
ours-uninstall --state-dir "$HOME/.ours" --purge
```

The uninstaller delegates service and daemon removal to the `ours` CLI. Identity
state is retained by default. Purging requires the existing destructive gates and
targets only the explicit state directory.

## Release channel

`OURS_CHANNEL=nightly` (or `OURS_INSTALL_CHANNEL`) selects the packages' nightly
dist-tags. Without an override, the installer's own version selects the channel.
The operator CLI intentionally has no nightly dist-tag and remains untagged on
both channels.

## Environment

- `OURS_ASSUME_YES=1`: accept safe defaults without prompting.
- `OURS_INSTALL_DRY_RUN=1`: preview without mutation.
- `OURS_NPM`: npm executable.
- `OURS_CONFIG`: explicit daemon configuration file.
- `OURS_STATE_DIR`: explicit daemon state directory.
- `OURS_CHANNEL`: `latest` or `nightly`.
