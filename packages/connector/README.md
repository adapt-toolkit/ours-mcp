# @ours.network/connector

Reactivity connector for any **webhook + shell-tool-calling harness** to receive ours.network
messages, where **each subagent binds its own ours identity** (multi-identity). Generalized from the
a2adapt/Hermes bridge. Zero runtime dependencies — it drives `ours-mcp proxy` over stdio (raw JSON-RPC).

## Design — N parallel (observe → wake → drain) triples, one per identity

1. **OBSERVE** (`connector-watch.sh`): one `ours-mcp watch <id>` per identity (non-binding, non-draining) →
   on each line, **poke** the gateway webhook with the identity tag. Never binds or drains.
2. **WAKE** (webhook): HMAC-SHA256-signed `POST` carrying the event (as an `X-GitHub-Event` header and an
   `event_type` body field — the two channels Hermes matches routes on) plus `{"identity":"<id>"}`. The connector
   **defines** the contract (config-overridable); the harness gateway matches.
3. **DRAIN** (per-identity sole-drainer): the gateway routes the wake to the subagent bound to `<id>`;
   its proxy calls `get_messages`. Sole-drainer holds per identity by construction — ours binding is
   exclusive per identity, so exactly one drainer per inbox. N identities = N sole-drained inboxes on
   ONE shared ours daemon.

## Delivery hardening
- **Drain-on-(re)connect** per identity — unconditional wake at startup + after each watch reconnect.
- **Poke retry/backoff** per identity — never silently drop the only wake.
- **Missed-wake backstop** (gateway-side, per identity) — periodic non-consuming `list_incoming` →
  drain only if unread. Lives in the gateway (which owns each binding), not the watcher.

## Webhook contract (config-overridable, both ends match)
```
POST  <CONNECTOR_WEBHOOK_URL>
body  {"event_type":"<CONNECTOR_EVENT>","event":"<CONNECTOR_EVENT>","identity":"<id>"}
hdr   X-GitHub-Event: <CONNECTOR_EVENT>            # event name, the way Hermes matches routes
hdr   X-Hub-Signature-256: sha256=<hex HMAC-SHA256(body, CONNECTOR_HMAC_SECRET)>
reply 200 accept · 401 bad signature · 400 unknown identity
```
Wakes are coalesced per-identity. The reference gateway **refuses to start** unless
`CONNECTOR_HMAC_SECRET` is set to a non-default value.

## Layout
| path | role |
|---|---|
| `connector.config.sh` | config: CLI, `CONNECTOR_IDENTITIES` list, session-prefix, port, state-dir, broker, webhook URL/secret/event, hardening knobs |
| `connector-watch.sh` | per-identity observe→poke watcher + drain-on-reconnect + retry |
| `connector-reference-handler.mjs` | reference gateway: HMAC-verify → 202 → route by identity → per-identity sole-drainer + backstop. Replace the drain block with each subagent's agent loop. |
| `connector-identity-setup.mjs` | one-shot: create root + one leaf per identity, bind, bio/persona |
| `connector-inbox-count.mjs` | per-identity non-consuming inbox check (ops/debug) |
| `e2e-sender.mjs` | e2e helper: send a message to a connector identity |
| `docs/DESIGN.md` | full design + generalization notes |

## Usage
```sh
export CONNECTOR_IDENTITIES="AgentA AgentB AgentC" \
       CONNECTOR_HMAC_SECRET=... \
       CONNECTOR_WEBHOOK_URL=http://localhost:8644/webhooks/ours-wake
ours-mcp start                          # one shared daemon for all identities
node connector-identity-setup.mjs       # create root + all identities
bash connector-watch.sh                 # per-identity watchers (supervise; self-reconnects)
# gateway: adapt connector-reference-handler.mjs — route wake.identity to that subagent's loop
```

## Validated
- Single-identity: watch → HMAC-poke → 202 → sole-drainer drained a real message; bad-sig → 401 (no crash).
- Multi-identity (AgentA + AgentB): each wake routed to the correct identity's drain, no cross-draining.

See `docs/DESIGN.md` for the a2adapt/Hermes-bridge generalization and foreign-harness notes.
