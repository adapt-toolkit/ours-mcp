# ours daemon configuration

ours-mcp is a client of one already-running shared daemon. The operator CLI owns
configuration and lifecycle:

```sh
ours config show --json
ours config setup --port 3050 --state-dir "$HOME/.ours"
ours daemon start
ours daemon status --json
```

The MCP adapter and `ours-codex` use the published SDK's coherent selection. The
wholly default selection is port 3050 with state directory `~/.ours`. For another
daemon, set `OURS_CONFIG`, or set matching `OURS_PORT` and `OURS_STATE_DIR`. A
token or endpoint selection must be paired with its state directory. `/state-dir`
is verified before credentials are sent.

The adapter never starts a daemon and never falls back to an embedded one.
`OURS_INSTANCE`, `--application`, and old ours-mcp daemon variables are errors.
Standard and live Codex mode use the same selection; live mode only adds an
explicitly armed, session-scoped wake monitor.

Changing daemon configuration or restarting the shared daemon affects every
connected application. Explain that blast radius and obtain the user's consent
before making operator-level changes.
