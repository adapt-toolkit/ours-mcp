# ours Monitoring & Shared Library Design

Status: IMPLEMENTED 2026-06-12 — Part 1 (monitoring), Part 4 (browser control
plane), and the messenger Control Panel are live; Part 2's TS extraction was
superseded by the ours-mufl-core submodule (see MUFL-CORE-MIGRATION-PLAN.md).
Verified by: spike-monitoring.mjs, spike-upgrade-monitoring.mjs,
messenger/scripts/spike-control-cross.mjs, messenger browser smoke (core 1.3).
Deviations from the plan: copies carry no original_msg_id (send side has none);
profile-level monitoring declaration in invites deferred to hardening;
introduce-carried first messages are not copied (only the send/receive paths,
per the transaction table).
Date: 2026-06-12
Reviewed by: crypto protocol researcher, critic (via ours)

---

## Overview

Two initiatives, interleaved:

1. **Agent Monitoring** — human operators observe agent-to-agent communication via root identity proxying
2. **Shared Client Library** — extract `ours-client-core` (MUFL + TS) into a separate repo/package consumed by both the MCP server and a future web browser control panel

---

## Part 1: Agent Monitoring

### Design Principles

1. **Opt-in, forward-only** — monitoring applies to future messages only, never retroactively
2. **Agents are aware** — when monitoring is enabled, the agent knows; peers can see it in the profile
3. **Root-only** — only the root identity can be the monitoring endpoint (no arbitrary backdoor); agents know their root via the delegation chain, so MITM is not possible
4. **Human proxy via random-digits verification** — root forwards monitoring traffic to a human's ours identity, bound via a 6-digit code verification (NOT standard invite exchange alone)
5. **Multi-root control panel** — a single human identity aggregates monitoring from multiple MCP roots (e.g. local machine + VPS), each independently bound

### Architecture

```
MCP Host A                    MCP Host B
┌──────────┐                 ┌──────────┐
│ Root A   │                 │ Root B   │
│  ├ role1 │──monitoring──►  │  ├ role3 │──monitoring──►
│  └ role2 │──monitoring──►  │  └ role4 │──monitoring──►
│          │                 │          │
│ proxy: H │                 │ proxy: H │
└────┬─────┘                 └────┬─────┘
     │                            │
     │  encrypted channel A-H     │  encrypted channel B-H
     ▼                            ▼
┌─────────────────────────────────────────┐
│  Human Control Panel (identity H)       │
│  - stream from Root A                   │
│  - stream from Root B                   │
│  - multiplex by root_cid                │
└─────────────────────────────────────────┘
```

Each root independently does an invite exchange with human identity H. Independent encrypted channels, no shared state between roots. H multiplexes by contact/root_cid.

### Proxy Binding Flow (Random Digits Verification)

1. Human initiates binding — invite exchange with root (standard Ring 3 path)
2. Root generates random 6-digit code → stores in packet state → displays on MCP host terminal
3. Human reads code from terminal (or receives it via SSH/trusted channel)
4. Human enters code in web application
5. Human's identity sends verification message to root
6. Root verifies: sender matches pending proxy, code matches, not expired, attempts < 3
7. On success: root sets `monitoring_proxy` state, sends confirmation
8. On failure: increment attempts; after 3 failures, cancel (human must restart)

Security: 6-digit code with 3 attempts max and 5-minute expiry → brute-force probability 0.0003%. Sufficient for PoC and production. For production hardening: derive SAS from DH shared secret (requires SDK hook).

### MUFL Transactions (New + Modified)

#### New State Fields (in `hidden` block)

```mufl
monitoring_enabled is bool = FALSE.

metadef proxy_pending_t: ($code -> str, $proxy_cid -> global_id, $expires_at -> time, $attempts -> int).
proxy_pending is proxy_pending_t+ = NIL.

metadef proxy_binding_t: ($proxy_cid -> global_id, $bound_at -> time).
monitoring_proxy is proxy_binding_t+ = NIL.

metadef monitoring_copy_t: (
    $version -> int,
    $source_cid -> global_id,
    $source_name -> str,
    $direction -> str,
    $peer_cid -> global_id,
    $peer_name -> str,
    $original_msg_id -> int,
    $original_date -> time,
    $body -> str
).

monitoring_inbox is monitoring_copy_t[] = [].
```

#### Transaction Summary

| # | Transaction | Packet | Purpose |
|---|------------|--------|---------|
| 1 | `sign_monitoring_auth` | root | Sign enable/disable authorization for a role |
| 2 | `set_monitoring` | role | Verify root-signed auth + store monitoring flag |
| 3 | `send_message` (MODIFIED) | role | Add monitoring copy branch on outbound messages |
| 4 | `receive_message` (MODIFIED) | role | Add monitoring copy branch on inbound messages |
| 5 | `receive_monitoring_copy` | root | Store incoming copies from roles in monitoring_inbox |
| 6 | `get_monitoring_copies` | root | TS pulls accumulated copies for proxy forwarding |
| 7 | `set_proxy_pending` | root | Store verification code (TS-generated; MUFL has no random source) |
| 8 | `verify_proxy_code` | root | Verify human's code, bind proxy contact |
| 9 | `describe_identity` (MODIFIED) | any | Add monitoring_enabled to output |

Total MUFL addition: ~150-200 lines.

#### Transaction Details

**1. `sign_monitoring_auth` (root-only)**
Root signs an authorization blob for enabling/disabling monitoring on a role. Aborts if delegation_cert exists (i.e. not root). Mirrors sign_delegation pattern.

**2. `set_monitoring` (role)**
Role receives root-signed auth blob, verifies signature against stored root public keys (from delegation chain), sets monitoring_enabled flag.

**3-4. `send_message` / `receive_message` (modified)**
After existing send/receive logic, if `monitoring_enabled == TRUE && delegation_cert != NIL`:
- Build monitoring_copy_t with direction, peer info, message body
- Send encrypted copy to root via `encrypted_channel::send_encrypted_tx root_cid`
- Root's CID is already stored in `delegation_cert $c $root_cid`

**5. `receive_monitoring_copy` (root)**
Root receives copies from roles, appends to monitoring_inbox, emits `_notify_agent` event.

**6. `get_monitoring_copies` (root)**
TS calls this to pull accumulated copies. Clears monitoring_inbox after read (same pattern as get_messages).

**7. `set_proxy_pending` (root)**
TS generates random code (MUFL has no random source), passes to root via this transaction. Stores code + proxy_cid + expiry + attempt counter.

**8. `verify_proxy_code` (root)**
Verifies sender matches pending proxy, code matches, not expired, attempts < 3. On success: sets monitoring_proxy, clears pending. On failure: increments attempts; after 3, cancels.

**9. `describe_identity` (modified)**
Add `$monitoring_enabled -> monitoring_enabled` to return data.

### MUFL vs TypeScript Boundary

**Principle: anything touching private keys or plaintext stays in MUFL.**

| What | Where | Why |
|------|-------|-----|
| Monitoring state (enabled flag) | MUFL | Packet-internal, influences message handling |
| Monitoring copy generation | MUFL | Plaintext available during send/receive inside VM |
| Wire format (monitoring_copy_t) | MUFL | Type definition + serialization |
| Root auth signing/verification | MUFL | Private keys never leave packet |
| Proxy binding state | MUFL | Root packet state |
| Proxy code verification | MUFL | Atomic state modification |
| Profile monitoring declaration | MUFL | Part of self-signed profile |
| Cross-packet enable flow | **TS** | Calls sign_monitoring_auth on root, then set_monitoring on role |
| Proxy code generation | **TS** | MUFL has no random source |
| Root→proxy forwarding | **TS** | Pulls get_monitoring_copies, calls send_message to proxy |
| Monitoring copy display | **TS** | Renders copies for dashboard |
| Multi-root aggregation | **TS** | Client-level multiplexing |

Note: root→proxy forwarding means plaintext briefly transits TS. Pre-TEE this is acceptable. Post-TEE, this forwarding should move into MUFL (root auto-forwards internally).

### Profile-Level Monitoring Declaration

Add to self-signed profile: `monitoring: { enabled: true, root_cid: "..." }`

Must be present from day one — adding later forces profile re-exchange with all contacts. Peers can see this flag and decide whether to communicate with a monitored agent.

### What to Defer (Hardening Phase)

| Item | Why safe to defer |
|------|------------------|
| OOB fingerprint verification (SAS from DH secret) | Random digits sufficient; SAS needs SDK hook |
| Signed monitoring copies (agent signs original metadata) | Agent honesty fine for PoC (we control all agents) |
| Handshake consent negotiation (Layer 2) | Profile declaration (Layer 1) enough for now |
| Per-message opt-out (Layer 3) | No external peers yet |
| Traffic correlation mitigations (batching/jitter) | No passive network adversaries in PoC |
| HSM/TPM root key storage | Development machines |
| Root key rotation protocol | Low risk in controlled environment |
| TEE integration | Phase 1+ roadmap |
| Monitoring scope configuration (all vs external-only) | Start with all channels |
| Command capability model | Proxy = full admin for PoC |
| Replay protection on commands | Controlled environment |
| Monitoring audit trail | Nice to have, not blocking |

---

## Part 2: Shared Library — `ours-client-core`

### Motivation

The MCP server (Node.js) and web browser control panel are two clients of the ours network. Both run the same MUFL VM (Node native / browser WASM) and need the same orchestration logic. The ADAPT SDK already compiles to WASM and runs in the browser with full client-side E2E encryption.

### Repository Structure

New repo: `ours-client-core` (git subrepo for now; npm publish later as `@ours/core`).

Location during development: `/home/shakhvit/work/adapt/ours/ours-client-core/`

```
ours-client-core/
├── src/
│   ├── index.ts              # Re-exports
│   ├── host.ts               # OursHost class (core orchestration)
│   ├── platform.ts           # Platform interface definition
│   ├── types.ts              # Identity, InboxMsg, ContactRoot, BookEntry, etc.
│   ├── transactions.ts       # MUFL transaction helpers (readonlyTx, mutatingTx, withLock, etc.)
│   ├── identity.ts           # Identity lifecycle (provision, restore, describe, delegate)
│   ├── contacts.ts           # Contact management (invite, add, remove, resolve)
│   ├── messaging.ts          # Message send/receive/lifecycle, send fallback chain
│   ├── monitoring.ts         # Monitoring enable/disable, copy forwarding, proxy binding
│   ├── book.ts               # Contact book (registrar, publish, read, write)
│   ├── session.ts            # Session binding (resolveBound, bindSession, isSessionAlive)
│   ├── invite.ts             # Invite pack/unpack (brotli compress/decompress + version prefix)
│   ├── rendering.ts          # AdaptValue → plain JS objects (contacts, inbox, pending, etc.)
│   └── gc.ts                 # GC timer logic
├── mufl_code/
│   ├── actor.mu              # MUFL source (protocol implementation, including monitoring)
│   ├── config.mufl           # MUFL config
│   └── *.muflo               # Compiled MUFL bytecode (build artifact, checked in for consumers)
├── platforms/
│   ├── node.ts               # NodePlatform: fs-based implementation
│   └── browser.ts            # BrowserPlatform: IndexedDB implementation (future)
├── package.json
├── tsconfig.json
└── README.md
```

### The Two Layers of Sharing

**Layer 1: MUFL code (actor.mu)**
This IS the protocol. Same file runs on both platforms via the MUFL VM. Transaction definitions, state schemas, key management, delegation, encrypted channels, contact management, and now monitoring — all live here. This is the most important shared artifact.

**Layer 2: TypeScript orchestration**
Wraps MUFL transactions into a usable async JS API. Identity lifecycle, session binding, message helpers, invite handling, rendering. Published to npm.

**The npm package bundles both layers.** The compiled .muflo file ships alongside the TS code. They must be version-matched — a TS layer calling transactions that don't exist in the .muflo is a runtime crash. Single semver for both.

Analogy: ADAPT SDK = JVM, .muflo = .jar, TS layer = application framework.

### Platform Interface

```typescript
interface Platform {
  // Seed persistence
  readSeed(name: string): Promise<string | null>;
  writeSeed(name: string, seed: string): Promise<void>;

  // Packet state persistence
  readState(name: string): Promise<Uint8Array | null>;
  writeState(name: string, data: Uint8Array): Promise<void>;

  // Contact book persistence
  readBook(): Promise<Record<string, BookEntry>>;
  writeBook(entries: Record<string, BookEntry>): Promise<void>;

  // Event log (content-free, append-only)
  appendEvent(name: string, event: Record<string, unknown>): Promise<void>;

  // Unread snapshot (content-free)
  refreshUnreadSnapshot(name: string, snapshot: UnreadSnapshot): Promise<void>;

  // Push notification to bound session
  notify(identityName: string, summary: string): void;

  // Bindings snapshot
  persistBindings(bound: string[]): Promise<void>;

  // Identity directory listing
  listPersistedNames(): Promise<string[]>;

  // Identity removal
  removeIdentityStorage(name: string): Promise<void>;

  // Random bytes
  randomBytes(n: number): Uint8Array;
}
```

**NodePlatform** (~200 lines): maps to filesystem (current code, extracted from plugin/src/index.ts)
**BrowserPlatform** (~200 lines, future): maps to IndexedDB + WebCrypto

### OursHost Class

The core orchestration class that both clients instantiate:

```typescript
class OursHost {
  constructor(platform: Platform, adaptWrapper: AdaptWrapper, unit: UnitInfo);

  // Identity lifecycle
  createIdentity(name: string): Promise<Identity>;
  createRootIdentity(name: string): Promise<Identity>;
  restoreIdentity(name: string, seed: string): Promise<Identity>;
  removeIdentity(name: string): Promise<void>;
  listIdentities(): Promise<IdentityInfo[]>;
  describeIdentity(name: string): Promise<IdentityDescription>;

  // Session binding
  bindSession(name: string, sessionId: string, force?: boolean): Promise<Identity>;
  unbindSession(sessionId: string): void;
  currentIdentity(sessionId: string): Identity | null;

  // Delegation
  delegateRole(rootName: string, roleName: string): Promise<void>;

  // Contacts
  generateInvite(name: string): Promise<string>;
  addContact(name: string, invite: string): Promise<ContactInfo>;
  removeContact(name: string, contactName: string): Promise<void>;
  listContacts(name: string): Promise<ContactInfo[]>;

  // Messaging
  sendMessage(name: string, contact: string, text: string): Promise<void>;
  getMessages(name: string): Promise<InboxMsg[]>;
  deferMessages(name: string, msgIds: number[]): Promise<void>;

  // Contact book
  setBookPolicy(enabled: boolean): Promise<void>;
  listLocalBook(): Promise<BookEntry[]>;

  // Bio
  setBio(name: string, bio: string): Promise<void>;

  // Monitoring (NEW)
  enableMonitoring(rootName: string, roleName: string): Promise<void>;
  disableMonitoring(rootName: string, roleName: string): Promise<void>;
  startProxyBinding(rootName: string, proxyCid: string): Promise<{ code: string }>;
  verifyProxyCode(rootName: string, code: string, senderCid: string): Promise<boolean>;
  getMonitoringCopies(rootName: string): Promise<MonitoringCopy[]>;
  forwardToProxy(rootName: string, copies: MonitoringCopy[]): Promise<void>;
}
```

### What Goes Where

| Concern | ours-client-core | MCP Server (ours-mcp) | Web App (future) |
|---------|-------------------|--------------------------|------------------|
| MUFL packet code (actor.mu) | ✓ bundled | imports from core | imports from core |
| OursHost class | ✓ | instantiates with NodePlatform | instantiates with BrowserPlatform |
| Platform interface | ✓ defined | ✓ NodePlatform impl | ✓ BrowserPlatform impl |
| MCP tool handlers | | ✓ thin wrappers | |
| CLI (daemon, watch, setup) | | ✓ | |
| Web UI components | | | ✓ |
| Service worker / push | | | ✓ |
| Multi-root monitoring dashboard | | | ✓ |

### Extraction Strategy (Critic's Advice)

**Phase 1: Extract stable code first.** Identity management, contacts, messaging, delegation, invite handling, session binding — these have been stable across releases. Extract them into ours-client-core.

**Phase 2: Build monitoring in MCP server.** Develop the monitoring TS orchestration (enableMonitoring, proxy binding, copy forwarding) inside the MCP plugin first. The MUFL transactions go into actor.mu in the shared repo from the start (no choice — MUFL is inherently shared).

**Phase 3: Extract monitoring TS to core.** Once the monitoring orchestration is proven and the interface stabilizes, move it from MCP plugin into ours-client-core.

**Phase 4: Build BrowserPlatform + web app.** The web control panel consumes ours-client-core with BrowserPlatform.

---

## Part 3: Implementation Plan

### Phase 1 — Create ours-client-core repo & extract stable code

**Tasks:**

1.1. Create folder structure at `/home/shakhvit/work/adapt/ours/ours-client-core/`
1.2. Initialize package.json, tsconfig.json
1.3. Copy `actor.mu`, `config.mufl`, and `.muflo` from `plugin/mufl_code/` to `ours-client-core/mufl_code/`
1.4. Define `Platform` interface in `src/platform.ts`
1.5. Define types in `src/types.ts` (extract from plugin/src/index.ts)
1.6. Extract transaction helpers into `src/transactions.ts` (readonlyTx, mutatingTx, withLock, enqueueMutation, wireHandlers)
1.7. Extract identity lifecycle into `src/identity.ts` (createPacket, provisionIdentity, restoreIdentity, describeIdentity)
1.8. Extract contact management into `src/contacts.ts` (invite, add, remove, resolve, findSibling)
1.9. Extract messaging into `src/messaging.ts` (sendViaSibling, sendViaLocalBook, fallback chain)
1.10. Extract contact book into `src/book.ts` (registrar, publish, read, write)
1.11. Extract session binding into `src/session.ts`
1.12. Extract invite handling into `src/invite.ts`
1.13. Extract rendering into `src/rendering.ts`
1.14. Extract GC into `src/gc.ts`
1.15. Implement `NodePlatform` in `platforms/node.ts`
1.16. Create `OursHost` class in `src/host.ts` composing all modules
1.17. Create `src/index.ts` re-exporting public API
1.18. Rewrite `ours-mcp/plugin/src/index.ts` as thin MCP wrappers calling OursHost
1.19. Test: all existing MCP tools work identically via the new architecture
1.20. Wire ours-mcp to consume ours-client-core as a local dependency (file: or workspace reference)

### Phase 2 — Add monitoring MUFL transactions

**Tasks:**

2.1. Add monitoring state fields to `actor.mu` (monitoring_enabled, proxy_pending, monitoring_proxy, monitoring_inbox, monitoring_copy_t)
2.2. Implement `sign_monitoring_auth` transaction (root-only)
2.3. Implement `set_monitoring` transaction (role)
2.4. Modify `send_message` — add monitoring copy branch
2.5. Modify `receive_message` — add monitoring copy branch
2.6. Implement `receive_monitoring_copy` transaction (root)
2.7. Implement `get_monitoring_copies` transaction (root)
2.8. Implement `set_proxy_pending` transaction (root)
2.9. Implement `verify_proxy_code` transaction (root)
2.10. Modify `describe_identity` — add monitoring_enabled
2.11. Add monitoring declaration to self-signed profile
2.12. Compile actor.mu → .muflo, test basic monitoring flow

### Phase 3 — Monitoring TS orchestration (in MCP server first)

**Tasks:**

3.1. Implement `enableMonitoring()` in MCP plugin — cross-packet flow (sign on root → set on role)
3.2. Implement `disableMonitoring()` in MCP plugin
3.3. Implement proxy binding flow — code generation, set_proxy_pending, display code
3.4. Implement proxy verification — detect verification message, call verify_proxy_code
3.5. Implement monitoring copy forwarding — periodic/event-driven pull from root, send to proxy
3.6. Add MCP tools: `enable_monitoring`, `disable_monitoring`, `bind_monitoring_proxy`, `get_monitoring_status`
3.7. Test: enable monitoring on a role, send messages, verify copies arrive at root
3.8. Test: bind proxy, verify copies forward to human identity
3.9. Test: multi-role monitoring (multiple roles → one root)

### Phase 4 — Extract monitoring to core & build web app (future)

4.1. Move proven monitoring TS orchestration from MCP plugin into ours-client-core
4.2. Implement `BrowserPlatform` (IndexedDB, WebCrypto, Push API)
4.3. Build web control panel consuming ours-client-core
4.4. Multi-root monitoring dashboard
4.5. Remote control (create roles, modify bios, send commands)
4.6. Random-digits verification UI in web app

---

## Part 4: Browser Control Plane (ADDED 2026-06-12)

The original plan listed "remote control (create roles, modify bios, send
commands)" as a deferred Phase-4 bullet. This part designs it fully and is
implemented together with monitoring.

**Note on Part 2:** the ours-client-core TS extraction was superseded by
the `ours-mufl-core` submodule (MUFL layer only — see
MUFL-CORE-MIGRATION-PLAN.md). The browser client is the existing `messenger`
app with its own host layer; monitoring/control TS orchestration lives in the
MCP plugin (per Phase 3) and the messenger host respectively.

### Capabilities (browser/messenger account, after secure binding to a root)

- See all agents (roles) of each bound MCP root, with role bios + monitoring state
- Contact any agent without invites (discovery through root: the root commands
  the agent to mint an invite, the messenger auto-redeems it)
- Create new agents (name + role description) on the MCP host
- Update role descriptions (bios)
- Enable/disable monitoring per agent; view the live monitoring feed

### Wire layer: `a2a_control` core library (core 1.3)

One symmetric, e2e-encrypted control transaction shared by both apps:

```
::a2a_control::control_message  ($payload -> str)   // inbound, encrypted, contacts-only
trn send_control ($contact, $payload)               // user-origin send helper
init ($on_control_received -> hook)                 // app storage/notify hook
```

Library trns are wire-routable (verified by the migration step-0 probe), so no
`::actor::` shims are needed — this is a NEW protocol surface with no legacy
clients. Unknown senders are rejected (must be a contact). Payloads are JSON
strings; the packet treats them as opaque.

### Control protocol (JSON over send_control, v1)

Requests proxy→root (each carries `id` for correlation):

| t | args | action on daemon |
|---|------|------------------|
| `bind` | code | verify_proxy_code(code, sender) → binds monitoring proxy |
| `list_agents` | — | roots + roles, bios, monitoring flags |
| `create_agent` | name, bio | provisionIdentity + delegateRole |
| `update_role` | agent, bio | set_my_bio on the role |
| `set_monitoring` | agent, enabled | sign_monitoring_auth → set_monitoring |
| `contact_agent` | agent | agent mints invite → returned → messenger auto-redeems |
| `remove_agent` | agent | remove_identity (roles only, never the root) |

Responses root→proxy: `{v:1, t:"res", id, ok, error?, ...data}`.
Pushed events root→proxy: `{v:1, t:"monitoring", copies:[…]}`.

Authorization: `bind` is allowed from any contact (the 6-digit code +
packet-side attempt/expiry state is the gate); everything else only from the
verified `monitoring_proxy` CID stored in the root packet.

### Daemon (MCP server process)

The MCP server process IS the daemon: control requests land in the root
packet's `control_inbox` (separate from the message inbox — agent sessions
never see them), a `$control_request` notify wakes the dispatcher, which
drains `get_control_requests`, executes, and replies via `send_control`.
Monitoring copies likewise: `$monitoring_copy` notify → `get_monitoring_copies`
→ forward to the bound proxy as a `monitoring` control event. Bodies are never
written to disk host-side; feed history persistence is messenger-side
(IndexedDB, local to the browser).

### Binding flow (random-digits, per Part 1)

1. Messenger account adds the root as a contact (standard invite, Ring 3)
2. Operator (in the Claude session / on the host) runs MCP tool
   `bind_monitoring_proxy(contact)` on the root → daemon generates a 6-digit
   code, stores it via `set_proxy_pending`, shows the code on the host only
3. Human enters the code in the messenger UI → `bind` control request
4. Daemon fires `verify_proxy_code` (sender + code + ≤3 attempts + 5-min expiry
   verified atomically in the packet) → on success replies ok + agent list
5. Messenger persists the binding locally and unlocks the Control Panel for
   that contact

### Messenger screens

- **Conversation header / contact actions**: "Control panel" entry for any
  contact; opens the bind flow when unbound, the panel when bound
- **Bind screen**: explains the procedure, 6-digit code input, error/attempt
  feedback
- **Control Panel — Agents tab**: agent list (name, role bio, monitoring
  badge), per-agent actions (chat via contact_agent, edit bio, toggle
  monitoring, remove), create-agent form
- **Control Panel — Monitoring tab**: live feed of monitoring copies
  (direction, agent, peer, body, time), persisted in IndexedDB, filter by agent

### Deferred (Hardening Phase)

- SAS derived from DH shared secret (needs SDK hook)
- Signed monitoring copies with original metadata
- Handshake consent negotiation (Layer 2)
- Per-message opt-out (Layer 3)
- Traffic correlation mitigations
- HSM/TPM root key storage
- Root key rotation protocol
- TEE integration (monitoring inside enclave)
- Monitoring scope configuration (all vs external-only)
- Command capability model + replay protection
- Monitoring audit trail
- Pull-based monitoring alternative (root queries role history on demand)
