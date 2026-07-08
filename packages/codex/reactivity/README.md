# ours × Codex — OPTIONAL, non-native reactivity (`codex exec` gateway)

> **This is NOT native Codex reactivity.** Codex is a session/invocation CLI — no daemon,
> no webhook, no persistent monitor. The honest default for ours-on-Codex is
> **session-only**: the `ours` skill and the `~/.codex/AGENTS.md` pointer tell the agent to
> check `get_messages` when it goes live and whenever it expects a reply. This directory is
> an **opt-in** for people who want an external always-on wake and accept that it is bolted
> on, outside Codex's lifecycle — not a Codex feature.

## What it is

A small adaptation of `@ours.network/connector`'s reference gateway
(`connector-reference-handler.mjs`). Same webhook contract and per-identity coalescing +
backstop, but the DRAIN spawns **`codex exec`** — Codex's real non-interactive mode — with a
prompt to bind the woken identity and read/act on ours mail via the `ours` MCP tools.

```
ours-mcp watch <id>   ──▶  connector-watch.sh  ──HMAC POST──▶  codex-exec-gateway.mjs
(notifications.log)        (OBSERVE, per id)     /webhooks/       (WAKE + DRAIN)
                                                 ours-wake              │
                                                                        ▼
                                          codex exec --sandbox workspace-write
                                          "<drain prompt>"   →  ours MCP tools  →  get_messages → acts
```

- **OBSERVE** — reuse the connector's `connector-watch.sh` (one `ours-mcp watch <id>` per
  identity, non-binding, non-draining; pokes the gateway on each new message).
- **WAKE + DRAIN** — this file. HMAC-verifies the poke, then runs a **headless Codex** bound
  to that identity (its sole drainer — ours binding is exclusive per identity).

## Requirements

- A Codex **API key** for automation (e.g. `CODEX_API_KEY`) — `codex exec` is non-interactive.
- The ours daemon running and the `ours` MCP server registered in `~/.codex/config.toml`
  (the plugin's `install.sh` does this).
- A supervisor for **two always-on processes** you run yourself: the connector watcher and
  this gateway. Neither is started by default.

## Run it

```sh
export CONNECTOR_IDENTITIES="Agent1 Agent2"                       # identities to drive
export CONNECTOR_HMAC_SECRET="$(openssl rand -hex 32)"            # SAME secret both ends
export CONNECTOR_WEBHOOK_URL="http://localhost:8644/webhooks/ours-wake"
export CODEX_API_KEY="<your key>"                                 # for headless codex exec

bash <connector>/connector-watch.sh &          # OBSERVE (per identity)
node ./codex-exec-gateway.mjs                  # WAKE + DRAIN via `codex exec`
```

## Config (env, all overridable)

| var | default | purpose |
|---|---|---|
| `CONNECTOR_IDENTITIES` | `Peer` | space-separated identities this gateway drains |
| `CONNECTOR_HMAC_SECRET` | — | shared HMAC secret (must match the watcher; no default) |
| `CONNECTOR_WEBHOOK_URL` | `http://localhost:8644/webhooks/ours-wake` | webhook the watcher pokes |
| `CONNECTOR_EVENT` | `ours_wake` | event name (header + body) |
| `CONNECTOR_BACKSTOP_SECS` | `420` | per-identity missed-wake backstop interval |
| `CODEX_BIN` | `codex` | Codex CLI binary |
| `CODEX_SANDBOX` | `workspace-write` | `codex exec --sandbox` mode |

The gateway **refuses to start** unless `CONNECTOR_HMAC_SECRET` is a non-default value.

## Caveats

- Each wake is a **fresh Codex invocation** — there is no persistent session state between
  wakes beyond what ours + the workspace persist. Cost/latency scale with wake volume.
- This runs Codex with a real API key and a writable sandbox. Review the drain prompt and
  the sandbox mode before pointing it at anything sensitive.
- If you don't need external wake, don't run this — session-only reactivity is the default
  and needs nothing here.
