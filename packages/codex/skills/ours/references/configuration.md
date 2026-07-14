# ours configuration and daemon profiles

Each ours daemon owns one port and one state directory. Multiple daemons can run on the
same host when both values are distinct. Configuration resolves as environment variables,
then the file named by `OURS_CONFIG` (otherwise `~/.ours/config.json`), then defaults:

| Setting | Environment | JSON key | Default |
|---|---|---|---|
| HTTP port | `OURS_PORT` | `port` | `3050` |
| State directory | `OURS_STATE_DIR` | `stateDir` | `~/.ours` |
| Broker | `OURS_BROKER_URL` | `brokerUrl` | bundled public broker |
| API token | `OURS_API_TOKEN` | `apiToken` | owner token file |
| API visibility | `OURS_API_VISIBILITY` | `apiVisibility` | `owner` |
| Auto-start | `OURS_AUTOSTART` | `autoStart` | `false` |

For live Codex mode, `ours-codex --ours-port <port>` has highest precedence. The launcher
queries `/info`, verifies the authenticated notification API, and propagates that exact
profile to the plugin, hooks, and watcher. It never starts or changes the daemon. A stopped
or incompatible selected daemon is an error.

Changing daemon configuration is separate operator work. Explain the impact and obtain
explicit consent before editing or restarting anything. A changed state directory selects a
different identity store. Use a distinct `OURS_CONFIG`, port, and state directory for a
second daemon.

Standard mode and live mode use the same MCP tools. Live mode only adds explicitly armed,
session-scoped wake; it stops with the `ours-codex` session.
