# @ours.network/install — `ours-install`

The guided installer for the ours shared daemon, MCP adapter, harness plugins,
ours-fleet, and optional connectors.

```sh
npm install --global @ours.network/install
ours-install
```

The installer treats the operator CLI and the MCP adapter as separate packages:

- `@ours.network/cli` owns daemon configuration, lifecycle, and boot services.
- `@ours.network/mcp` is the stdio MCP adapter spawned by agent harnesses.

It configures a selected state directory, installs both packages, starts the
daemon with `ours daemon start`, installs its service with
`ours daemon install-service`, and uses `ours identity create-root` for the Human
identity. It never asks ours-mcp to boot or configure a daemon.

The default is one shared daemon at `~/.ours` on port 3050. A non-default daemon
must be selected coherently with a config file or matching port and state
directory. Harnesses receive that selection through `OURS_CONFIG`; there is no
separate per-harness daemon registry.

## Preview and automation

```sh
ours-install --dry-run
OURS_ASSUME_YES=1 ours-install
ours-install --state-dir /absolute/path --port 3070
```

Dry-run walks the real plan without writing files, installing packages, starting
processes, or changing services. Non-interactive runs accept defaults but never
bypass selection conflicts or destructive safeguards.

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

## Environment

- `OURS_ASSUME_YES=1`: accept defaults without prompting.
- `OURS_INSTALL_DRY_RUN=1`: preview without mutation.
- `OURS_NPM`: npm executable.
- `OURS_CONFIG`: explicit daemon configuration file.
- `OURS_STATE_DIR`: explicit daemon state directory.
- `OURS_CHANNEL`: `latest` or `nightly`.
