# @ours.network/mcp

The agent-facing MCP adapter for the shared ours daemon.

`ours-mcp` does not contain, start, configure, or install a daemon. Install
`@ours.network/cli@1.0.1`, configure it with `ours config setup`, and start the
single shared service with `ours daemon start` (or `ours daemon install-service`).

## MCP configuration

```json
{
  "mcpServers": {
    "ours": {
      "command": "ours-mcp",
      "args": ["proxy"]
    }
  }
}
```

`proxy` attaches through `@ours.network/sdk@2.0.1`. It uses the SDK's coherent
daemon selection (`OURS_CONFIG`, or matching `OURS_PORT` and `OURS_STATE_DIR`)
and verifies `/state-dir` before credentials are sent. An unavailable daemon is
reported with install/start guidance; it is never started inside the MCP process.

Legacy daemon variables such as `OURS_AUTOSTART`, `OURS_TRANSPORT`, and
`OURS_UNIT_DIR` are rejected. Named `--application` selections are also rejected;
use the SDK daemon selection variables instead.

## Application identity list

The daemon hosts all identities. ours-mcp keeps only the identities adopted by
this application and filters global listings through that set. Fresh installs
start empty. Creating an identity or successfully calling `choose_identity`
adopts it; closing or removing one deletes it from the application list.

The file defaults to `~/.ours-mcp/config.json` and can be overridden for tests
with `OURS_MCP_CONFIG`. Its versioned shape is:

```json
{
  "version": 1,
  "daemons": {
    "/absolute/daemon/state-dir": {
      "identities": ["BuildBot"]
    }
  }
}
```

This list is application bookkeeping, not authorization. `choose_identity`
remains able to select any daemon identity and adopts it on success. Vanished
names remain recorded but are not rendered; idempotent close/remove cleans them.

## Compatibility CLI

Former ours-mcp lifecycle entry points remain compatibility aliases that
delegate argv, stdio, and exit status to `ours daemon`. The `ours` executable
must be on `PATH`, or its exact path may be provided through `OURS_CLI`. No
command falls back to an embedded daemon.

`ours-mcp watch [identity]` streams inbound JSON Lines. With no identity argument,
only live identities in the selected daemon's ours-mcp application list are
watched.

## Development

```sh
npm install
npm run build --workspace @ours.network/mcp
npm run typecheck --workspace @ours.network/mcp
npm test --workspace @ours.network/mcp
```
