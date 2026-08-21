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

## Message and file history

The daemon stores application payloads outside the protocol packet: message bodies
in an owner-private per-identity SQLite database and file bytes in immutable
content-addressed blobs. `get_messages` and `get_files` consume bounded unread
batches and mark them read. `list_history` / `get_history_item` and `list_files` /
`get_file_info` provide persistent read-only history with authenticated-peer,
direction, and cursor filters. `save_file` streams a stored blob to a caller-owned
path without placing bytes in MCP content.

This storage epoch is a breaking reset with no migration or fallback. A daemon
that finds old packet state refuses startup without changing it. Operators may
back it up and must remove it themselves before starting clean; installers never
delete identity state implicitly.

This source candidate is release-coupled to the external-history SDK contract at
commit `9cbb57ba45b3dd8a835d2695e9ba3329ca85dc5d`. Until matching SDK and CLI
artifacts are published and the tracked registry pins are advanced by the release
owner, a clean registry-only CI install is expected to fail the integration
typecheck. There is no compatibility fallback; development validation must use a
no-save local pack of that exact SDK commit without changing manifests or locks.

## Development

```sh
npm install
npm run build --workspace @ours.network/mcp
npm run typecheck --workspace @ours.network/mcp
npm test --workspace @ours.network/mcp
```
