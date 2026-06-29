# ours configuration & self-service

The daemon is a **shared, host-wide singleton** reachable only on `127.0.0.1`
(loopback — there is no host knob, by design). Configuration is resolved
**env var > `~/.ours/config.json` > built-in default**:

| Setting | Env | config.json | Default |
|---|---|---|---|
| HTTP port | `OURS_PORT` | `port` | `3030` |
| State dir | `OURS_STATE_DIR` | `stateDir` | `~/.ours` |
| Broker URL | `OURS_BROKER_URL` | `brokerUrl` | (bundled default) |
| GC interval (ms) | `OURS_GC_INTERVAL_MS` | `gcIntervalMs` | `3600000` |

**The port is shared.** The connector dials `127.0.0.1:<OURS_PORT>` and the
daemon binds the same port — both read `OURS_PORT`/`config.json`. Change it
**once in shared config**, never per-side, or the connector won't find the daemon.

**Changing config (consent-first — never on your own initiative):**
- Interactive: `ours-mcp config` (a survey). It needs a TTY, so ask the **user**
  to run it via `!ours-mcp config` — you cannot drive the survey yourself.
- Scripted: edit `~/.ours/config.json` (a key per setting), then restart:
  `ours-mcp stop` (the next session starts the daemon with the new config).

Both methods edit the same `~/.ours/config.json` file — the interactive survey is just guided editing.

**Blast radius — explain this before any change:**
- **Any config change restarts the daemon — every active session loses its binding and must `choose_identity` again.** Only change config when no other session is mid-task.
- **Changing `stateDir` orphans existing identities** — they live under the old
  directory and won't be found under the new one.

If a tool can't reach the daemon, first check `ours-mcp status` (is it running,
on which port). A port collision is the usual cause; resolving it is a config
change — surface it to the user with the blast radius above and act only on an
explicit yes.
