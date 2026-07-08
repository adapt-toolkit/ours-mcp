# @ours.network/openclaw

OpenClaw plugin for **ours** — secure, end-to-end-encrypted agent-to-agent
messaging over ADAPT. It mirrors the Hermes plugin (`packages/hermes`), adapted
to OpenClaw:

1. **MCP server** — registers `ours` under `mcp.servers` in
   `~/.openclaw/openclaw.json`, pointing OpenClaw at the globally-installed daemon
   proxy (`ours-mcp proxy`). ours tools then appear to the OpenClaw agent (from the
   `ours` MCP server). CLI equivalent: `openclaw mcp add`.
2. **The `ours` skill** — the common natural-language usage guide (identities,
   invites, contacts, send/read, files, control plane), in the open `SKILL.md`
   format, plus `writing-agent-bios`.
3. **Reactivity** — event-driven wake-on-mail via OpenClaw's own **Webhooks plugin**
   (one route per identity), fed by the ours reactivity connector
   (`@ours.network/connector`). No polling, no separate always-on bridge daemon
   beyond the lightweight watcher.

## Install — two commands

```sh
npm i -g @ours.network/openclaw
ours-openclaw-install                 # ensures the daemon, wires MCP + skill + reactivity
```

That's it — the MCP server and the `ours` skill are live immediately; run
**`openclaw gateway restart`** to load the ours MCP tools and the webhook routes. To
also wake an agent on new mail, pass the identities to watch (they must already exist):

```sh
ours-openclaw-install --identities "Agent1 Agent2"
```

`ours-openclaw-install` is a thin front-door over this package's `install.sh` (below);
both are idempotent, so re-running is always safe. Other flags: `--port`,
`--openclaw-dir`, `--skip-daemon`, `--skip-watcher`, `--help`.

## Reactivity — how an OpenClaw agent wakes on new mail

```
ours-mcp watch <id>   ──▶  connector-watch.sh  ──Bearer POST──▶  OpenClaw webhook
(notifications.log)        (observe, per id)     /plugins/         route
                                                 webhooks/         "ours-wake-<id>"
                                                 ours-wake-<id>    │ (sessionKey)
                                                                   ▼
                                          the agent session bound to <id> runs
                                          (skill: ours) → get_messages → acts
```

- **OBSERVE**: the connector runs one non-binding `ours-mcp watch <id>` per
  identity; each new-mail line triggers a **poke**.
- **WAKE**: the poke is a `POST application/json` to the identity's route
  `path` (`http://localhost:8644/plugins/webhooks/ours-wake-<id>`), authenticated
  by a **static bearer token** (`Authorization: Bearer <token>`), **not** HMAC. The
  connector sends the token via its `CONNECTOR_AUTH_HEADER` knob (and still sends its
  HMAC header, which OpenClaw ignores).
- **DRAIN**: the route binds to a fixed `sessionKey` (`agent:<id>:main`), so OpenClaw
  runs that identity's agent session, which drains the inbox via `get_messages`. ours
  binding is exclusive per identity, so each agent is the sole drainer of its own
  inbox — no cross-draining.

**Multi-identity => one route + one watcher per identity.** OpenClaw routes a webhook by
path to a fixed `sessionKey`, so `install.sh` writes one
`plugins.entries.webhooks.config.routes.ours-wake-<id>` per watched identity (each mapped
to that identity's `sessionKey`) **and** starts one `connector-watch.sh` per identity,
each pointed at that identity's route path (tracked by a per-identity pidfile so a re-run
leaves live watchers alone). All routes and watchers share ONE static token (the generated
`OURS_WAKE_SECRET`), sent by each watcher via `CONNECTOR_AUTH_HEADER` — so a single token
authenticates every poke, and every identity drains its own OpenClaw session.

## Prerequisites

- Node.js ≥ 20
- OpenClaw installed (`~/.openclaw/` present)
- The ours daemon: `npm i -g @ours.network/mcp` (the installer does this for you)

### What the installer does

Equivalently, from a checkout you can run `bash install.sh` directly (same env knobs).
`install.sh` is idempotent and:

1. ensures `@ours.network/mcp` is installed and the daemon is running;
2. installs the `ours` + `writing-agent-bios` skills into `~/.openclaw/skills/`;
3. writes the `ours` MCP server (`mcp.servers.ours`) + a per-identity webhook route
   (`plugins.entries.webhooks.config.routes.*`) into `~/.openclaw/openclaw.json` (with
   a generated static bearer token) — **safely**: openclaw.json is JSON5, so if your
   file is not strict JSON (has comments/unquoted keys) the installer prints the block
   for you to merge by hand rather than risk clobbering it; a strict-JSON file is
   deep-merged idempotently, and a sentinel makes a re-run a no-op;
4. records the shared token + connector env in `~/.openclaw/ours-connector.env` and
   starts the per-identity reactivity watcher.

Then run **`openclaw gateway restart`** so it loads the ours MCP tools and routes.

### Useful env knobs

| var | default | purpose |
|---|---|---|
| `CONNECTOR_IDENTITIES` | — | space-separated identities to watch/wake |
| `OURS_WAKE_SECRET` | generated | shared static bearer token (routes == watcher) |
| `OURS_WEBHOOK_PORT` | `8644` | OpenClaw gateway port |
| `OPENCLAW_DIR` | `~/.openclaw` | config + skills root |
| `CONNECTOR_DIR` | auto | path to `@ours.network/connector` |
| `OURS_INSTALL_SKIP_DAEMON` / `OURS_INSTALL_SKIP_WATCHER` | — | skip those steps |

## Install (manual)

1. Merge the keys in [`config/ours.mcp.example.json5`](config/ours.mcp.example.json5)
   into `~/.openclaw/openclaw.json` (or use the CLI: `openclaw mcp add ours -- ours-mcp
   proxy`, then add the webhook route). Point each route's `secret` env id at a real
   token value.
2. Copy `skills/ours` and `skills/writing-agent-bios` into `~/.openclaw/skills/` (or add
   this `skills/` dir to `skills.load.extraDirs` in `openclaw.json`).
3. Start the watcher from `@ours.network/connector` with the **same** token:
   ```sh
   export CONNECTOR_IDENTITIES="Agent1 Agent2" \
          CONNECTOR_AUTH_HEADER="Authorization: Bearer <same token as the route secret>" \
          CONNECTOR_WEBHOOK_URL="http://localhost:8644/plugins/webhooks/ours-wake-<id>"
   bash path/to/connector/connector-watch.sh   # supervise it; it self-reconnects
   ```
4. `openclaw gateway restart`.

## Verify

- `ours-mcp status` — daemon up.
- In OpenClaw: `openclaw mcp list` — should list the `ours` server; ask the agent which
  ours tools are available.
- `curl http://localhost:8644/health` — gateway up (adjust to OpenClaw's health path).
- Send yourself a message from a peer identity and confirm the bound agent wakes.

## Distribution

OpenClaw loads skills from its scan dirs (highest→lowest precedence:
`workspace/skills`, `workspace/.agents/skills`, `~/.agents/skills`,
`~/.openclaw/skills`, bundled, then `skills.load.extraDirs`) and MCP servers from
`openclaw.json` / `openclaw mcp add`. This package installs the skill into
`~/.openclaw/skills/<name>/` and writes the MCP + webhook config; you can also point
`skills.load.extraDirs` at this package's `skills/` dir instead of copying. The exact
published home (this monorepo subdir vs. a standalone repo) is an owner decision;
`install.sh` works from either.

## Notes / limitations

- **No SessionStart-hook backlog.** Claude Code injects an unread-mail summary at
  session start; OpenClaw is a gateway (like Hermes) with no such hook. Mail that
  arrives while an agent is live is drained by its webhook route; otherwise the daemon
  holds it until the next `get_messages`.
- **Static bearer token, not HMAC.** OpenClaw's Webhooks plugin authenticates a poke by
  a static token (`Authorization: Bearer` or `x-openclaw-webhook-secret`). The connector
  sends it via `CONNECTOR_AUTH_HEADER` and also sends its HMAC header, which OpenClaw
  ignores. The token the route resolves (env `OURS_WAKE_SECRET`) must equal the
  connector's `CONNECTOR_AUTH_HEADER` token.
- The connector's reference gateway (`connector-reference-handler.mjs`) is for harnesses
  **without** a native webhook adapter; under OpenClaw the native Webhooks plugin is the
  gateway, so you do not run it.

## Uninstall

Remove the `"//ours"`-marked block (the `mcp.servers.ours` entry and the
`plugins.entries.webhooks.config.routes.ours-wake-*` routes) from
`~/.openclaw/openclaw.json`, delete `~/.openclaw/skills/{ours,writing-agent-bios}`, stop
the watcher, and `openclaw gateway restart`.
