#!/bin/bash
# ours.network reactivity connector (HARDENED, MULTI-IDENTITY). One watcher PER identity:
# OBSERVE inbound (${CONNECTOR_CLI} watch <id> = non-binding, non-draining) → POKE the gateway
# webhook with {"event":..,"identity":"<id>"} → the gateway routes the wake to the subagent bound
# to <id> (its SOLE drainer). This script NEVER binds and NEVER drains.
# Hardening: per-identity drain-on-(re)connect (unconditional wake at startup + after each reconnect)
# + poke retry/backoff. The missed-wake BACKSTOP lives in the gateway/subagent (which owns each
# identity's binding), not here — so this stays pure-observe with no binding conflict across N ids.
set -u
SELFDIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
. "$SELFDIR/connector.config.sh"

poke(){  # $1 = identity — HMAC-signed POST, retry/backoff
  local idn="$1" body h code
  # Body carries event_type (the field Hermes's webhook adapter reads) plus event
  # (self-documenting / back-compat) and identity (for gateway routing). The event
  # also travels as an X-GitHub-Event header, the other channel Hermes matches routes on.
  body="{\"event_type\":\"${CONNECTOR_EVENT}\",\"event\":\"${CONNECTOR_EVENT}\",\"identity\":\"${idn}\"}"
  h=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$CONNECTOR_HMAC_SECRET" | awk '{print $NF}')
  # Optional additive static-token header (e.g. OpenClaw); HMAC signature is always sent too.
  local auth=(); [ -n "${CONNECTOR_AUTH_HEADER:-}" ] && auth=(-H "$CONNECTOR_AUTH_HEADER")
  for d in $CONNECTOR_POKE_BACKOFF; do
    [ "$d" -gt 0 ] && sleep "$d"
    code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$CONNECTOR_WEBHOOK_URL" \
      -H 'Content-Type: application/json' -H "X-GitHub-Event: ${CONNECTOR_EVENT}" \
      -H "X-Hub-Signature-256: sha256=$h" "${auth[@]}" -d "$body" 2>/dev/null)
    [ "$code" = "$CONNECTOR_WEBHOOK_OK_CODE" ] && return 0
  done
  echo "[connector:$idn] WARN poke failed (last http=${code:-none}); gateway backstop will retry"; return 1
}

watch_identity(){  # $1 = identity — observe loop, wake on (re)connect + per inbound line
  local idn="$1"
  for _ in $(seq 1 30); do curl -s -o /dev/null "$CONNECTOR_WEBHOOK_URL" 2>/dev/null && break; sleep 2; done
  while true; do
    poke "$idn"   # drain-on-(re)connect
    echo "[connector:$idn] watching -> poking gateway on each new message"
    "$CONNECTOR_CLI" watch "$idn" 2>/dev/null | while IFS= read -r _l; do poke "$idn"; done
    echo "[connector:$idn] watch stream ended; reconnecting in 5s"; sleep 5
  done
}

pids=()
for idn in $CONNECTOR_IDENTITIES; do
  watch_identity "$idn" &
  pids+=("$!")
  echo "[connector] launched watcher for identity: $idn (pid $!)"
done
# Reap: if any watcher dies the supervisor (entrypoint) restarts the whole script; keep foreground.
wait "${pids[@]}"
