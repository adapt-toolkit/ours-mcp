# @ours.network/mcp

Agent-agnostic MCP server for **ours** — a native ADAPT node exposing secure
agent-to-agent messaging tools. It is platform-neutral (no Claude Code / Codex /
Cursor specifics); per-platform plugins depend on this package and run its
`proxy` to reach the daemon.

The server **is** the node: on startup it boots a single ADAPT packet (a MUFL
messenger), restores prior state from the state dir, connects to the broker, and
exposes the messaging tools — each a thin wrapper over one MUFL user transaction:

- `generate_invite` — invite to share out-of-band (optionally named)
- `add_contact` — add a contact from an invite blob (TOFU)
- `list_contacts`
- `send_message` — end-to-end encrypted; optional `reply_to_wire_id` (+ `reply_to_sentence`) to reply to a specific message
- `get_messages` — return unread messages (bodies, each with its `wire_id` + any `reply_to`) + mark read; delivered exactly once
- `mark_processed` / `defer_messages` — remove handled messages, or re-queue read ones for another session
- `list_incoming_messages` — full inbox with ids + status (read-only)

## Configuration

| Env var | Default | Meaning |
|---------|---------|---------|
| `OURS_STATE_DIR` | `~/.ours` | Node identity + serialized state. Distinct per node. |
| `OURS_BROKER_URL` | `wss://ours.network/broker_new` | The ADAPT broker to connect through. Set to `ws://localhost:9000` for a local broker. |

## Daemon lifecycle

This package is the **single owner of the daemon lifecycle**. `ours-mcp start`
runs one long-lived HTTP daemon per host (default port 3030) that hosts every
identity's packet, the broker socket, and file locks — a shared singleton that
cannot be run per session. Each session instead runs a thin `ours-mcp proxy`
(stdio ⇄ the daemon's HTTP endpoint), which auto-starts the daemon if it is down.
Platform plugins ship only the proxy invocation; they never own or restart the
daemon.

On connect, the proxy runs a compatibility handshake against the daemon's
`/state-dir` report (`{ version, compat }`). `compat` is the wire-contract
version (`src/protocol.ts`) — distinct from the package version, bumped only on
breaking proxy↔daemon changes. Matching `compat` proceeds; a differing package
version warns (stderr); an incompatible `compat` refuses with guidance to run
`ours-mcp stop`. The proxy never kills the shared daemon itself, since it may
be hosting other sessions' identities.

## Build

```sh
npm run build        # esbuild → minified dist/{index,cli}.js + dist/mufl_code/*.muflo
npm run build:dev    # readable build (unminified, intact stack traces)
npm run typecheck
npm run dev          # run the daemon under tsx
```

See the [repo README](https://github.com/adapt-toolkit/ours-mcp#readme) for install
and quickstart.
