# ours.network connector (WIP core, MULTI-IDENTITY)

Reusable reactivity connector for any **webhook + shell-tool-calling harness** to receive ours.network
messages, where **each subagent binds its own ours identity** (not just the top-level agent). Generalized
from the Hermes a2adapt bridge. **Packaging-agnostic core** — repo structure/naming follow Vitaly's
packaging spec (pending); these are the transport-layer artifacts.

## Design — N parallel (observe → wake → drain) triples, one per identity
1. **OBSERVE** (`connector-watch.sh`): one `ours-mcp watch <id_i>` per identity (non-binding,
   non-draining) → on each line, **poke** the gateway webhook with the identity tag. Never binds/drains.
2. **WAKE** (webhook): HMAC-SHA256-signed `POST` carrying the event (`X-GitHub-Event` header + `event_type`
   field, both matched by Hermes) and `{"identity":"<id_i>"}`. The connector
   **defines** the contract (config-overridable); the harness gateway matches.
3. **DRAIN** (per-identity sole-drainer): the gateway routes the wake to the subagent bound to `<id_i>`;
   that subagent's proxy calls `get_messages`. **Sole-drainer holds per identity by construction** —
   ours binding is exclusive per identity, so exactly one drainer per inbox. N identities = N
   independent sole-drained inboxes on ONE shared ours daemon.

## Delivery hardening
- **Drain-on-(re)connect** (per identity): unconditional wake at startup + after each watch reconnect.
- **Poke retry/backoff** (per identity): never silently drop the only wake.
- **Missed-wake backstop** (gateway-side, per identity): periodic non-consuming `list_incoming` →
  drain only if unread. Lives in the gateway/subagent (which owns each binding), NOT the watcher —
  so the watcher stays pure-observe with no cross-identity binding conflict.

## Webhook contract (config-overridable, both ends match)
```
POST  <CONNECTOR_WEBHOOK_URL>
body  {"event_type":"<CONNECTOR_EVENT>","event":"<CONNECTOR_EVENT>","identity":"<id>"}
hdr   X-GitHub-Event: <CONNECTOR_EVENT>            # event name, the way Hermes matches routes
hdr   X-Hub-Signature-256: sha256=<hex HMAC-SHA256(body, CONNECTOR_HMAC_SECRET)>
reply 200 accept · 401 bad signature · 400 unknown identity
```
Wakes are **coalesced per-identity**. The reference gateway refuses to start unless
`CONNECTOR_HMAC_SECRET` is set to a non-default value.

## Files
| file | role |
|---|---|
| `connector.config.sh` | config: CLI, `CONNECTOR_IDENTITIES` (list), session-prefix, port, state-dir, broker, webhook URL/secret/event, hardening knobs |
| `connector-watch.sh` | one observe→poke watcher per identity + drain-on-reconnect + retry |
| `connector-identity-setup.mjs` | one-shot: create root + one leaf per identity, bind, bio/persona |
| `connector-reference-handler.mjs` | reference gateway: HMAC-verify → 200 → route by identity → per-identity sole-drainer + backstop. Replace the drain block with each subagent's agent loop. |
| `connector-inbox-count.mjs` | per-identity non-consuming inbox check (ops/debug helper) |

## Usage
```sh
export CONNECTOR_IDENTITIES="AgentA AgentB AgentC" CONNECTOR_HMAC_SECRET=... CONNECTOR_WEBHOOK_URL=http://localhost:8644/webhooks/ours-wake
ours-mcp start                     # one shared daemon for all identities
node connector-identity-setup.mjs  # create root + all identities
bash connector-watch.sh            # per-identity watchers (supervise it; self-reconnects)
# gateway: adapt connector-reference-handler.mjs — route wake.identity to that subagent's loop
```

## Generalization from the Hermes a2adapt bridge
`a2adapt-mcp` → `CONNECTOR_CLI` (ours-mcp) · `A2ADAPT_PORT/STATE_DIR` → `OURS_PORT/STATE_DIR` ·
broker → `wss://broker1.ours.network` (0.3.x default) · single identity → `CONNECTOR_IDENTITIES` list ·
webhook URL/secret/event/CLI → config · wake body gains `identity` for routing.

## Validated (isolated daemon, e2e)
- Single-identity: watch → HMAC-poke → 202 → sole-drainer drained a real message; bad-sig → 401 (no crash).
- Multi-identity (AgentA + AgentB): each wake routed to the correct identity's drain, **no cross-draining**.

## Hermes foreign-harness test
Hermes's existing gateway handler is `/webhooks/a2adapt-wake`, event `a2adapt_wake`. To reuse it, set on
BOTH ends: `CONNECTOR_WEBHOOK_URL=.../a2adapt-wake` `CONNECTOR_EVENT=a2adapt_wake` — or rename the Hermes
handler to `ours-wake`/`ours_wake`. Hermes must also route the wake's `identity` to the right subagent.

**Canonical defaults are PROVISIONAL** — Vitaly's packaging spec may fix the canonical event-name/payload.
