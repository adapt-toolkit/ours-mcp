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
| `OURS_BROKER_URL` | `wss://broker1.ours.network` | The ADAPT broker to connect through. Set to `ws://localhost:9000` for a local broker. |

### Voice-message transcription

Voice transcription is off until a provider and key (plus provider-required fields) are
configured. Check readiness without exposing credentials:

```sh
ours-mcp voice-setup
ours-mcp voice-status --json
```

`voice-setup` presents a keyboard-driven single-choice provider selector and reads the
provider key with hidden input. It writes config atomically with mode `0600`, preserves
unrelated fields, and rolls back if the managed daemon cannot restart and report ready.
It never accepts a key in command arguments. For environment-only service configuration
use `OURS_STT_PROVIDER`, `OURS_STT_API_KEY`, `OURS_STT_MODEL`, `OURS_STT_BASE_URL`, and
`OURS_STT_LANGUAGE`; environment values override file fields.

The supported providers are `openai-compatible` (explicit base URL + model),
`elevenlabs` (model), `deepgram`, and `custom` (`stt.custom.url`). Incoming voice remains
a file and is transcribed only when its real `audio/*` MIME also carries
`x-ours-kind=voice-message` (or its legacy filename starts `voice-message-`). The original
bytes are saved whether transcription succeeds, is unconfigured, exceeds the size cap, or
the provider fails. Provider error text is scrubbed if it echoes the configured key.

Telegram fallback preserves its original OGG/Opus bytes and `.ogg` filename and advertises
`audio/ogg; x-ours-kind=voice-message`; the connector's v2 message envelope correlates the
separate file using `attachment.wire_id`.

## Daemon lifecycle

This package is the **single owner of the daemon lifecycle**. `ours-mcp start`
runs one long-lived HTTP daemon per host (default port 3050) that hosts every
identity's packet, the broker socket, and file locks — a shared singleton that
cannot be run per session. Each session instead runs a thin `ours-mcp proxy`
(stdio ⇄ the daemon's HTTP endpoint), which auto-starts the daemon if it is down.
Platform plugins ship only the proxy invocation; they never own or restart the
daemon.

`ours-mcp start` and `ours-mcp restart` do not treat an open socket as readiness.
They wait for an authenticated response from the daemon's normal control
surface (`/identities`) after the protocol runtime, contact-book registrar,
persisted identities, and boot reconciliation are complete. In owner mode the
CLI dynamically discovers the mode-`0600` token minted by the daemon before it
declares readiness; shared and open modes preserve their configured auth
semantics. During that wait the daemon publishes a mode-`0600`
`startup-progress.json` in its state directory. The structured record contains
only a phase, timestamps, process/boot identifiers, and identity counts — never
identity names, container IDs, keys, packet contents, or state paths.

Interactive terminals update one progress line; redirected/noninteractive runs
emit concise stable lines such as `startup: Restoring identities 3/12`. A
heartbeat distinguishes active work from a frozen process: 30 seconds without
an update is a failure, and an absolute three-minute bound prevents an
event-loop-active stall from waiting forever. Immediate daemon failure remains
nonzero. The same daemon bootstrap/reporting path is used by foreground
`serve`, Linux systemd, macOS launchd, and either native or WASM-backed ADAPT
runtimes; service managers keep their existing lifecycle behavior.

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
