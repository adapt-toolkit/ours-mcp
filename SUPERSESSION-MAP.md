# App-layer supersession map — core 1.4 → 2.1 (ours MCP daemon)

Classifies every app-level subsystem (actor.mu + its TS-daemon helpers) against
what core 2.0/2.1 now provides:

- **A** = core now implements this → delete the app version, delegate to core.
- **B** = distinct mechanism core does NOT provide → keep.
- **C** = judgment call: deletion changes behaviour/governance/semantics → flag, do not decide unilaterally.

> **Headline (honest):** in THIS core checkout the supersession surface is
> NARROWER than "core now implements almost the entire daemon" implies. Most of
> the app layer is genuinely app-specific and core does NOT cover it: message
> inbox+lifecycle is app-side *by core's own design*; the local registrar
> contact book is a distinct trust path core preserves; the identity-hierarchy
> transactions are still app-side because **there is no `a2a_hierarchy.mm` in
> this core**; and the role→root monitoring model is a *different governance
> product* from core B1, not a drop-in. The clean wins are: (1) the
> capabilities/app_id wiring (done, chunk 1), and (2) tightening `export_state`
> to delegate persistence to core so 2.1 fields survive. Everything else is
> "keep" or "owner governance decision".

---

## Classification table

| # | Subsystem (actor.mu / TS) | Class | One-line rationale |
|---|---|---|---|
| 1 | Inbox store + lifecycle (`message_t`, `inbox`, `get_messages`, `gc`, `defer_messages`, `deposit_message`, `next_msg_seq`) | **B** | Core deliberately keeps message STORAGE app-side (a2a_messaging.mm:5-8) and only injects hooks. No core equivalent. |
| 2 | Storage-hook wiring (`a2a_messaging::init` on_message_received/sent/contact_removed) | **B** | Required integration glue. Unchanged. |
| 3 | Control transport wiring (`a2a_control::init`) | **B** (updated) | Delegates to core transport; chunk 1 added the now-required `$app_id`. |
| 4 | Capabilities manifest (`a2a_capabilities::init` describe hook) | **NEW** | Mandated by core 2.0 (fail-closed introduction gate). Done in chunk 1. |
| 5 | Local contact book (`registrar_ad`, `pin_registrar`, `mint_introduction`, `sign_book_entry`, `connect_local`, `approve/reject_introduction`, `list_pending_introductions`, `local_introduce`, `seen_nonces`, `pending_introductions`; TS `ensureRegistrar`/`pinRegistrar`/`publishToBook`/`sendViaLocalBook`) | **B** | Host-local registrar-signed introductions — a DISTINCT trust path from core CP-introduction. 2.0 says legacy direct paths are additive/preserved; wire shapes still in a2a_protocol.mm:101-112. NB: this `list_pending_introductions` is the local-book queue, NOT the removed core connect tx. |
| 6 | Identity hierarchy txs (`sign_delegation`, `export_root_profile`, `set_delegation`, `describe_identity`, `connect_sibling`, `sibling_introduce`; TS `delegateRole`) | **B** (future A) | Core holds hierarchy STATE (delegation_cert/root_ad/root_profile/contact_roots) and `verify_peer_delegation`, but a2a_messaging.mm:16-19 says the hierarchy TRANSACTIONS live in `a2a_hierarchy.mm` — which is **absent from this core checkout**. So core INTENDS to absorb them but 2.1 does not. Keep until a2a_hierarchy ships, then revisit as A. |
| 7 | App monitoring — role→root copy model (`monitoring_enabled`, `sign_monitoring_auth`, `set_monitoring`, `monitoring_inbox`, `receive_monitoring_copy` [::actor::], `get_monitoring_copies`, `monitor_copy_actions`; app proxy state + `set_proxy_pending`/`verify_proxy_code`/`clear_monitoring_proxy`/`get_monitoring_status`; TS `setAgentMonitoring`/`forwardMonitoring`/`bind_monitoring_proxy`/enable+disable tools) | **C** | Different governance product from core B1. See "Class C detail" below. Recommend KEEP; do not swap. |
| 8 | Control-request drain (`control_inbox`, `get_control_requests`; TS `processControlRequests`/`handleControlRequest` → create_agent/bind/…) | **B** | Core a2a_control gives the TRANSPORT (already used) and a2a_capabilities a verb DISPATCHER (unused). The host-drained queue + JSON `{t:…}` protocol is app architecture, still load-bearing. Optional future alignment to `a2a_capabilities::dispatch`, but that's a refactor + wire change, not a supersession. |
| 9 | App config | **N/A** | actor.mu has NO app-config subsystem; `config.ts` is runtime config (broker/port/stateDir/gc), unrelated to core B3 `set_app_config`. index.ts never touches `app_config`. Core B3 available but unused; constraint forbids a config panel. Nothing to delete. |
| 10 | `export_state` / `import_state` (compose `export_core_state` + app fields) | **A** (blocked on #7) | `export_state` (actor.mu:1126-1153) hand-lists core fields and DROPS new 2.1 fields. Delegate persistence to core. Detail below. |

---

## Class C detail — app monitoring (role→root) vs core B1 (node→CP)

These are **not** the same mechanism with two addresses; they are different products:

| Axis | App model (actor.mu, today) | Core B1 (a2a_messaging) |
|---|---|---|
| Topology | role → its ROOT (root buffers `monitoring_inbox`; host drains `get_monitoring_copies` → forwards to human proxy via `send_control`) | node → CP DIRECT (chokepoint fire-and-forgets to `a2a_monitoring::receive_monitoring_copy`; no root aggregation, no host drain) |
| Enable | per-role, ROOT-SIGNED auth (`sign_monitoring_auth` + `set_monitoring`) — cryptographically gated, opt-in per role | per-node proxy bind (6-digit); once `monitoring_proxy` set, emits unconditionally |
| "Bind proxy" | sets the ROOT's app `monitoring_proxy` (forwarding target for aggregated copies) | sets the HIDDEN core `monitoring_proxy` (the copy sink AND the introduction-relay authorizer AND config authority) |
| Field names | app `proxy_pending`/`monitoring_proxy` | core hidden `proxy_pending`/`monitoring_proxy` — **same blob key names** (collision, see #10) |

**Semantics delta if swapped to B1:**
1. Copies bypass the root aggregation + host drain — the daemon's `forwardMonitoring`/`get_monitoring_copies` path goes dead.
2. The per-role root-signed enable (`sign_monitoring_auth`) has **no B1 equivalent** — B1 monitors a node iff its proxy is bound, so the granular root-authorized per-role toggle is **lost**.
3. 2.1 deliberately parks monitoring-inheritance-on-root-bind, so a root binding a CP does NOT cascade to roles. Under B1, monitoring N roles means binding the CP on each role individually (heavier than today's one-root-signs-for-all).

**Critical coupling note (for the cluster work + the Coordinator's runtime-verify item):**
core B1's `monitoring_proxy` is ALSO the authority for `require_cluster_cp_or_abort`
(introduction relays) and `set_app_config`. BUT the chokepoint emits a copy
whenever `monitoring_proxy != NIL`. So binding core's `monitoring_proxy` purely
to accept introductions would **silently turn on forced copy emission to that CP**.
The clean separation the 2.1 design relies on: cluster CHILDREN accept
introductions via inherited **`root_cp_binding`** (the root-signed edge,
re-verified locally) — NOT by binding `monitoring_proxy` — so they get the accept
gate WITHOUT copy emission. This is exactly why children must inherit
`root_cp_binding`, and it confirms the Coordinator's verify-item (ii): the
introduction path must not light up the copy path.

**Verdict:** do NOT swap. Recommend keeping the app role→root monitoring as-is
(matches the original Q1 ruling). Any migration to B1 is a separate,
owner-approved governance change carrying the three deltas above.

---

## Class A detail — `export_state` persistence delegation (blocked on #7)

`export_state` (actor.mu:1126-1153) does `core_state = a2a_messaging::export_core_state NIL`
then cherry-picks fields. It emits `my_name, contacts, pending_invites, peer_ads,
my_bio, delegation_cert, root_ad, root_profile, contact_roots` from `core_state`
but **OMITS the new core 2.1 fields**: `root_cp_binding`, `managed_roots`,
`contact_cp_bindings`, `app_config`. Result: those are **dropped on every
persist/upgrade round-trip**. For the headline cluster feature, `root_cp_binding`
MUST persist, so this is a real bug, not cosmetics.

**Fix (the thin-app win):** stop hand-listing core fields — overlay the app-owned
fields onto the full `export_core_state` result, so any field core adds in future
is carried automatically.

**Blocker / collision:** `export_core_state` already emits `$proxy_pending` and
`$monitoring_proxy` (the HIDDEN core monitoring state), and actor's `export_state`
ALSO emits `$proxy_pending`/`$monitoring_proxy` (the APP monitoring state) under
the **same keys**. A naive "spread core_state + keep app monitoring fields"
collides. So the persistence fix is **entangled with the #7 monitoring decision**
— we must namespace one side (e.g. app monitoring under `app_*` keys) before
delegating persistence. I'll propose a concrete blob shape once #7 is ruled.

---

## Recommendation summary

- **Do now (no governance impact):** keep chunk 1; once #7 is ruled, apply the #10 `export_state` delegation so 2.1 fields persist.
- **Owner decision needed:** #7 — keep app role→root monitoring (recommended) vs migrate to core B1 node→CP (governance change).
- **Keep (B):** inbox/lifecycle, local contact book, identity hierarchy (until a2a_hierarchy ships), control-request queue.
- **Not applicable:** app config (none; core B3 unused; panel forbidden).
- **Separately escalated (Q2):** root-side cluster PRODUCER txs (mint `root_cp_binding`, emit `enroll_delegated_node`) are absent from core 2.1 — gates the cluster wiring regardless of this map.
