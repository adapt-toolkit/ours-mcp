# ours configuration & self-service

The daemon is a **shared, host-wide singleton** reachable only on `127.0.0.1`
(loopback — there is no host knob, by design). Configuration is resolved
**env var > `~/.ours/config.json` > built-in default**:

| Setting | Env | config.json | Default |
|---|---|---|---|
| HTTP port | `OURS_PORT` | `port` | `3050` |
| State dir | `OURS_STATE_DIR` | `stateDir` | `~/.ours` |
| Broker URL | `OURS_BROKER_URL` | `brokerUrl` | (bundled default) |
| GC interval (ms) | `OURS_GC_INTERVAL_MS` | `gcIntervalMs` | `3600000` |
| Auto-start daemon | `OURS_AUTOSTART` | `autoStart` | `false` |

**The port is shared.** Every process that dials the daemon — the `ours-mcp proxy` MCP
server and `ours-mcp watch` — connects to `127.0.0.1:<OURS_PORT>`, and the daemon binds the
same port (both read `OURS_PORT`/`config.json`). Change it **once in shared config**, never
per-side, or a dialer won't find the daemon.

**Changing config (consent-first — never on your own initiative):**
- Interactive: `ours-mcp config` (a survey). It needs a TTY, so ask the **user**
  to run it via `!ours-mcp config` — you cannot drive the survey yourself.
- Scripted: edit `~/.ours/config.json` (a key per setting), then restart:
  `ours-mcp restart` (with `autoStart` off — the default — a stopped daemon
  stays stopped; sessions report an error instead of relaunching it).

Both methods edit the same `~/.ours/config.json` file — the interactive survey is just guided editing.

**Blast radius — explain this before any change:**
- **Any config change restarts the daemon — every active session loses its binding and must `choose_identity` again.** Only change config when no other session is mid-task.
- **Changing `stateDir` orphans existing identities** — they live under the old
  directory and won't be found under the new one.

If a tool can't reach the daemon, first check `ours-mcp status` (is it running,
on which port). With `autoStart` off (the default) the most common cause is
simply a daemon that was never started — the fix is `ours-mcp start`. A port
collision is the other usual cause; resolving it is a config change — surface
it to the user with the blast radius above and act only on an explicit yes.

## Voice-message transcription

Run `ours-mcp voice-status --json` first. It reports only readiness, provider,
key presence/source, and a missing-field reason; it never returns the key. A
ready result is idempotent: keep it and do not ask for setup again. A not-ready
result should be offered again on every interactive `ours-install` rerun.
Headless/`OURS_ASSUME_YES` runs never prompt and never invent credentials.

Safest guided setup: ask the user to run `ours-install` in their own terminal.
Its API-key prompt is hidden, it writes `config.json` atomically with mode
`0600`, and it restores the prior file if the daemon cannot reload the change.
Never request a provider key in chat, pass one through an agent tool/command
argument, print the `stt` config block, or test with a real key. Environment-only
operators can set `OURS_STT_PROVIDER`, `OURS_STT_API_KEY`, `OURS_STT_MODEL`,
`OURS_STT_BASE_URL`, and `OURS_STT_LANGUAGE`; environment values override the
file field-by-field.

Provider requirements:

- `openai-compatible`: key + explicit `/v1` base URL + model.
- `elevenlabs`: key + model; base URL is optional.
- `deepgram`: key; model/base URL are optional provider defaults.
- `custom`: key + `stt.custom.url`; model is required when the custom template
  references it.

Troubleshooting:

- “not ready” names the missing field. Do not ask the user to reveal its value.
- If a file edit appears ineffective, check the reported key source and
  `OURS_STT_*`; an environment override may shadow the file.
- Config changes require a daemon restart and active sessions may need to bind
  their identity again.
- Incoming voice is recognized strictly as an `audio/*` MIME carrying
  `x-ours-kind=voice-message`, or the legacy `voice-message-…` audio filename.
  Generic audio and connector-specific filename guesses remain ordinary files.
- Telegram fallback preserves the original OGG/Opus bytes and `.ogg` filename.
  Its `send_file` MIME and correlated v2 envelope `attachment.mime` must both be
  `audio/ogg; x-ours-kind=voice-message`; `attachment.wire_id` identifies the
  separately delivered file. Connector-local STT success may remain text-only.
- Oversized audio is saved but not uploaded (daemon default: 5 MiB). Provider
  HTTP, timeout, malformed-response, and network failures degrade to a precise
  “transcription failed” line with the saved audio path; provider responses are
  scrubbed if they echo the configured key.
