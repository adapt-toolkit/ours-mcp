# ours configuration & self-service

The daemon is normally a **single host-wide instance** reachable only on
`127.0.0.1` (loopback — there is no host knob, by design). One host *can* run
more than one, but only under the rules in "Running a second daemon" below.
Configuration is resolved **env var > `~/.ours/config.json` > built-in default**:

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

`OURS_CONFIG` points at a config file other than `~/.ours/config.json`. It is
the only way to give a second daemon its own file.

**Changing config (consent-first — never on your own initiative):**
- Interactive: `ours-mcp setup` (a survey). It needs a TTY, so ask the **user**
  to run it via `!ours-mcp setup` — you cannot drive the survey yourself.
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

`ours-mcp status --json` is the machine-readable form — prefer it when you need
to reason about the answer rather than show it. Beyond the text version it
reports `ownDaemon`: whether the daemon answering on your port is really the one
your configuration selects. `running: true` with `ownDaemon: false` means you are
looking at **someone else's daemon** — see below.

## Running a second daemon

A daemon owns exactly one **(port, state directory)** pair. A second daemon
needs **both** to differ. A different port alone is not enough.

**Sharing a state directory is forbidden.** Two daemons writing one state
directory interleave writes into the same identity packets and key material.
This is enforced, not merely advised: at startup a daemon takes an exclusive
lock on `<stateDir>/daemon.lock` and refuses to start if another live daemon
owns that directory (exit code 4). A port that is already taken is refused the
same way (exit code 3), naming which daemon is sitting there.

Working recipe today — no new commands, just the two env vars:

```sh
export OURS_PORT=3070
export OURS_STATE_DIR="$HOME/.ours-work"
ours-mcp start
ours-mcp status --json          # expect ownDaemon: true
ours-mcp create-root "Work Root"
```

Every `ours-mcp` command run in **that shell** targets that daemon; a shell
without those variables is back on the default one. Port 3051 is reserved (the
Telegram connector), so pick something else if you are choosing by hand.

**Two daemons are two separate presences on the network.** A state directory
*is* an identity set, so the second daemon has its own root identity, its own
contacts, and its own API token. An identity created on one is invisible to the
other, and `create-root` run against a new state dir creates a *second,
unrelated* root — never assume it is a no-op there.

**How each caller picks a daemon today:** every dialer — the `ours-mcp proxy`
MCP server, `ours-mcp watch`, and every `ours-mcp` subcommand — resolves the
endpoint from **its own** environment, then `OURS_CONFIG`/`~/.ours/config.json`.
There is no per-workspace or per-session selector: to point a client at a
non-default daemon, the **user** must launch that client with `OURS_PORT` and
`OURS_STATE_DIR` already set. You cannot retarget a running session, and editing
shared config to do it would move *every* session. Named instances (a
first-class selector) are planned; they do not exist yet.

`OURS_INSTANCE` gives a daemon a **name** (lower-case, `[a-z0-9._-]`, ≤32
chars). It shows up in `/info`, in `status --json`, and in collision messages
("port 3070 is already in use by instance \"work\""), which is what makes those
messages readable. It is a label only — it selects no port, state dir, or config
file. Do not present it to a user as a way to choose a daemon.

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
