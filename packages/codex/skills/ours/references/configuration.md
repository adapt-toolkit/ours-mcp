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

With no explicit `--ours-port`, `OURS_PORT`, `OURS_CONFIG`, or `OURS_STATE_DIR`, both standard
Codex and `ours-codex` use Codex's association in `~/.ours/installer-profiles.json` before the
historical default config. The selected config and daemon `/info.stateDir` must match the
registry; drift/auth failures stop with rerun-Nightly guidance. The registry never stores tokens.

Changing daemon configuration is separate operator work. Explain the impact and obtain
explicit consent before editing or restarting anything. A changed state directory selects a
different identity store. Use a distinct `OURS_CONFIG`, port, and state directory for a
second daemon.

Standard mode and live mode use the same MCP tools. Live mode only adds explicitly armed,
session-scoped wake; it stops with the `ours-codex` session.

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
