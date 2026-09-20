# @ours.network/mcp

The agent-facing MCP adapter for the shared ours daemon.

`ours-mcp` does not contain, start, configure, or install a daemon. Install
`@ours.network/cli@2.2.0`, configure it with `ours config setup`, and start the
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

`proxy` attaches through `@ours.network/sdk@3.7.0`. It uses the SDK's coherent
daemon selection (`OURS_CONFIG`, or matching `OURS_PORT` and `OURS_STATE_DIR`)
and verifies `/state-dir` before credentials are sent. An unavailable daemon is
reported with install/start guidance; it is never started inside the MCP process.

Legacy daemon variables such as `OURS_AUTOSTART`, `OURS_TRANSPORT`, and
`OURS_UNIT_DIR` are rejected. Named `--application` selections are also rejected;
use the SDK daemon selection variables instead.

The plugins include `@ours.network/mcp` and launch its local stdio server.
Tools call the selected daemon through `@ours.network/sdk` using the existing
authenticated HTTP API. The profile contains `endpoint`, `expectedInstanceId`,
and `credentialPath`; the endpoint can be localhost or a remote origin.
No remote MCP endpoint is used. The daemon does not need the MCP package.

Local file paths are interpreted by the local MCP process: `send_file` uploads
local bytes through the SDK, `save_file` downloads to local disk, and
`define_local_identity_file` writes the local workspace file. Native session
records and application identity visibility remain on the client host.

Host-client helpers select explicit `OURS_CONFIG` first, otherwise the private
`~/.ours-client/profile.json` when present, otherwise their existing unmanaged
configuration. The managed file contains the same
`endpoint`/`expectedInstanceId`/`credentialPath` tuple; an invalid or unreadable
managed profile is an error, never a fallback to a local daemon. This selection
also applies to the helpers bundled in Codex and Claude. It does not change the
SDK daemon configuration default or application/native-session state.

When a complete external host profile is selected, the stdio server
starts without allocating an owner. Its first tool call selects the native
logical session from Codex request `_meta.threadId`, or from the existing
`CLAUDE_CODE_SESSION_ID` fallback when that value identifies the Claude
session. Initialization and tool discovery do not need owner metadata. The
connector stores a random owner UUID in private recovery metadata below the
ours-mcp config directory and recovers that owner after an MCP process recycle.
Different native session selectors keep separate clients, bindings and arrival
watches. Closing stdio closes transport/watch resources; it does not release
the logical owner.

The existing `session-end` hook command reads `session_id` from its JSON stdin.
For a host profile it persists that owner's exact terminal intent before asking
the daemon to release the lease, and records the end only after the release is
acknowledged. A pending release is retried before any successor owner can be
allocated. A later call for an ended selector receives a fresh owner UUID.
If the terminal hook is disabled or never delivered, no terminal cleanup is
claimed: ordinary MCP recycle and resume recover the existing owner, and its
protected resources remain available.

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

The external-history and typed-command integration requires the published `@ours.network/sdk@3.7.0`
and `@ours.network/cli@2.2.0` artifacts. Both are pinned exactly so registry-only
installs use the validated contract; there is no compatibility fallback.

## Typed commands

`list_contact_commands` returns a contact's advertised command catalog as data.
`send_command` accepts arbitrary JSON-compatible arguments, delegates advertised-schema
validation and transport to the SDK, and returns the request wire ID. Later
`get_messages` calls expose `command_results` (correlated by `reply_to.wire_id`) and
`commands_handled` alongside ordinary unread messages. The connector never turns a
remote catalog into dynamically registered MCP tools and does not advertise commands
of its own.

## Development

```sh
npm install
npm run build --workspace @ours.network/mcp
npm run typecheck --workspace @ours.network/mcp
npm test --workspace @ours.network/mcp
```

### External-profile verification

The existing host-profile checks are part of `npm test`. Build the core package
and prepare the selected SDK/CLI artifacts first. For the daemon-backed native
selector, proxy-recycle, SessionEnd and token-refresh checks, run from this package:

```sh
OURS_TEST_DAEMON_CLI=/absolute/path/to/selected/cli/dist/cli.js npm run test:external-profile
```

Use an isolated Docker environment and test-owned state. These tests do not log
in to Codex/Claude and do not replace actual native harness acceptance.

### Container entrypoint

The packaged `dist/container.js` entrypoint is used only when a host integration
explicitly selects a Compose profile. It preserves daemon/profile validation,
application visibility, file transfer and notification operations. Standard
`ours-mcp proxy` and host-only installations do not require Docker. The entrypoint
uses the daemon state directory (`OURS_STATE_DIR`, default `/var/lib/ours`) and its
private `.mcp` profile; it is an internal launcher interface, not an additional
service or a replacement for normal host startup.

### Remote clients over HTTPS

A client may select an `https://` origin backed by a TLS reverse proxy. Keep the
daemon listener private and configure the proxy separately with a certificate
trusted by the client and matching the hostname. Node uses its normal trust
store; a private CA may be supplied through `NODE_EXTRA_CA_CERTS` before starting
the client. Certificate verification must remain enabled.

The existing issued client credential works over either transport; changing the
URL scheme does not require a new credential. Keep the server's master on the
server. Forward `x-ours-api-token` and the `x-ours-*` session headers unchanged,
and support streamed request/response bodies and long polling. Client requests
refuse redirects, including HTTPS-to-HTTP redirects: configure the final HTTPS
origin directly. UUID/capability checks still precede credential-bearing calls.

This adds client HTTPS support, not an HTTPS daemon listener, certificate
provisioning or automatic reverse-proxy configuration. Existing local HTTP and
SSH-tunnel profiles continue to work.
