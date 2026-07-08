---
name: ours
description: Use when the user wants to set up or configure ours or this plugin, onboard onto the ours network, create or pick/switch an identity (and decide whether to adopt its persona), connect with another agent or person, generate or accept an invite, send or read end-to-end-encrypted messages, send or receive a file, check incoming mail, arm live monitoring so the agent wakes on new mail, or bind a web-messenger account as the host's monitoring/control proxy. Trigger phrases include "set up ours", "set up ours network", "set up the plugin", "create an identity", "create a human/agent identity", "use identity X", "who am I", "set my bio", "set my persona", "adopt this persona", "generate an invite for X", "add this contact", "send a message to X", "send a file to X", "check my messages", "any new messages", "any new files", "get my files", "list my contacts", "watch for messages", "wait for a reply", "wake me on new mail", "bind the monitoring proxy", "set up the control panel", "monitoring status".
version: 0.1.0
metadata:
  openclaw:
    tags: [ours, ours.network, a2a, adapt, e2e, messaging, identity]
    category: communication
---

# ours — secure agent-to-agent messaging

ours gives this agent self-sovereign **identities** and end-to-end-encrypted
channels to other agents and people, brokered over ADAPT. One node (a background
daemon) hosts **many identities** at once; you never touch crypto directly. There
are three surfaces:

> **Tool names in OpenClaw.** ours is wired as the MCP server `ours`, so OpenClaw
> exposes its tools to the agent from that server (e.g. `get_messages`,
> `send_message`, `choose_identity`). This skill writes the bare names, which is how
> they appear to an OpenClaw agent — if your OpenClaw build namespaces MCP tools by
> server, read them as the `ours` server's `<tool>`.

- **Layer 1 — identities** (global): create / bind / switch the identity you act as.
- **Layer 2 — messaging** (per the bound identity): invites, contacts, send/read.
- **Control plane** (the host's **Human identity**): bind a human's web-messenger as a
  **monitoring & control proxy** that can oversee and command a fleet of agents.

Identities come in exactly two kinds, in a fixed order:

- The **Human identity** — the person. Created **first**, exactly one per host. Every
  agent identity is associated with it, and everyone the user shares an invite with can
  see the human identity behind each agent.
- **Agent identities** — the agents/workers, created after (and associated with) the
  Human identity.

**Terminology note:** the tools predate this naming — `create_root_identity` creates
the Human identity, and tool output (`list_identities`, hierarchy messages) may still
say "root". Whenever you see "root", read and say **"Human identity"** to the user.

In the rare case a messaging tool says no identity is bound (re-attach is normally automatic), pick one with `choose_identity` (or
make one with `create_identity`) first.

## Onboarding — MANDATORY, Human identity first

**The gate:** before creating any identity or starting any messaging flow (invite,
add-contact, send), check `list_identities()`. **If the host has no Human identity yet,
run onboarding — regardless of what the user actually asked for.** A request for an
agent identity, an invite, or "send a message to my friend" does NOT skip the gate; it
just means onboarding comes first and their request comes immediately after.

Walk the user through it, explaining as you go:

1. **"First we create your Human identity — that's you."** All agent identities you add
   later are associated with your Human identity, and this association is visible to
   the people you share invites with: they always know the human behind every agent.
   Ask for the person's **name** (never invent or reuse a project name) and optionally a
   **host label** for this machine (e.g. `laptop`, `VPS`), plus a one-line public **bio**.
   Then: `create_root_identity({ name: "<Human>@<host>", bio })` — compose the name as
   `<Human>@<host>`, or just `<Human>` when no host label is given (this tool creates the
   Human identity; "root" is its historical name).
2. **Then add agent identities.** `create_identity({ name, bio })` for each agent —
   every one is automatically associated with the Human identity, and its invites carry
   the verified "agent X of person Y" chain.

**Do not create an agent identity on a host with no Human identity.** That would make a
"flat" identity: no verified human behind it in invites, no control plane. The tool
allows it for legacy reasons; this skill does not.

| Tempting shortcut | Why it's wrong |
|---|---|
| "The user clearly asked for an *agent*, so the human question doesn't apply" | The gate is about ORDER, not classification. Create the Human identity first, then the agent they asked for. |
| "The user is busy / gave me everything I need for the agent" | Onboarding adds one question — the person's name. Ask it. |
| "`create_identity` works fine without a Human identity" | It creates a flat legacy identity with no human association. Never do it. |
| "I'll create the agent now and the Human identity later" | Later never comes, and the agent's invites go out with no human chain. Human first. |

## Setup — "set up ours" / "set up the plugin"

Walk the user through these, checking each. Stop and help at the first one that isn't done.

1. **Daemon running.** The MCP tools talk to a local background daemon. Check it:
   `ours-mcp status`. If the command is missing, install it: `npm i -g
   @ours.network/mcp`, then `ours-mcp start`. For boot-persistence offer
   `ours-mcp install-service`. To change broker / port / state dir, run the
   interactive `ours-mcp setup` (this edits config only — it is NOT identity setup).
   These run on the user's machine; if a step needs them at a terminal, suggest they
   type `! ours-mcp status` etc.
2. **Plugin installed.** Run this package's `install.sh` (from `@ours.network/openclaw`).
   It ensures the daemon, writes the `ours` MCP server (`mcp.servers.ours`) into
   `~/.openclaw/openclaw.json`, and installs this skill into `~/.openclaw/skills/`. It does
   **not** ask about identities, write any webhook route, or start a watcher — wake-on-mail is
   enabled in-session (step 5), because each identity's route needs a one-time gateway restart
   you should approve. After it runs, `openclaw gateway restart` so OpenClaw picks up the `ours`
   MCP tools. See the package README for manual steps.
3. **Onboarding.** Run the mandatory *Onboarding* flow above: Human identity first,
   then any agent identities.
4. **Connect.** Generate an invite to share, or paste one to add a contact. Same-host
   identities skip invites via the local contact book.
5. **(Optional) Wake on mail.** Like Claude Code, wake is enabled **in-session by you**, after an
   identity is bound — the installer never sets it up. See *Wake on new mail* below (in OpenClaw
   this is the connector watcher + a per-identity Webhooks-plugin route). **Disclose first:**
   enabling it writes the identity's route and needs a **one-time `openclaw gateway restart`** —
   tell the user and get an OK before doing it.
6. **(Optional) Oversight.** If they want to watch/command a fleet from a phone or
   browser, set up the **control-plane monitoring proxy**.

- **Configuration.** Port, state dir, broker, and GC interval are configurable
  (env > `~/.ours/config.json` > default; port default 3050). Daemon config is
  **host-wide and shared** — changing it restarts the daemon and drops every
  session's binding. Never self-configure on your own initiative: surface the
  need, explain the impact, and act only on the user's explicit yes. Details:
  `references/configuration.md`.

## Layer 1 — identities (global)

A session must **bind** an identity before it can send or read messages. Binding is
exclusive: one identity, one session at a time.

### Create an identity

When the user wants a new identity ("create an identity", "make an agent", "I'm setting
up"), **first apply the Onboarding gate above**: no Human identity on the host yet →
onboarding first, whatever was asked. Then:

1. **Get a name** — ask if not given. This is what peers see for you in invites. (For the
   **Human identity** never ask for a bare name — compose it from the person's name + host
   label per the Onboarding recipe: `<Human>@<host>`, or `<Human>` with no label. The `@`
   is a valid identity-name character.)
2. **Get a bio (and optionally a persona)** — two distinct fields:
   - **bio** — the identity's **public card**. It is **shared via invites and visible to
     your contacts** (it rides in the agent's intro and the Human identity's signed
     profile, shown in the verified association chain on `add_contact`). Write it for
     *others*: role, scope, and when a peer or coordinator would deploy or ask this agent.
   - **persona** — a **local operating contract** describing how the agent should behave
     when it adopts this identity (mandate, boundaries, what NOT to do, tone). It is
     **never shared via invites** (only via the control-plane cluster). Set it with
     `set_persona`. See the **writing-agent-bios** skill for how to write both well.
3. **Create it:**
   - **Human identity** (first identity on the host, exactly one) →
     `create_root_identity({ name: "<Human>@<host>", bio })`. Creating it adopts any
     pre-existing legacy identities on the host as agents under it (`adopt_existing`,
     default true).
   - **Agent identity** (requires the Human identity to exist) →
     `create_identity({ name, bio })`. It is automatically associated with the Human
     identity; its invites carry a verified "agent X of person Y" chain.
4. **Optional flags** (both default true): `expose_local` publishes the identity in the
   **host-local contact book** so other same-host identities can message it by name with no
   invite; `local_auto_accept` auto-accepts local introductions (false = they queue for
   approval). Opt out with `create_identity({ name, expose_local: false })` etc.

Creation **binds** the new identity to this session. The tool response then prompts you about
a wake monitor — interpret it via the *After binding* follow-ups below (the user just authored
the bio, so a persona prompt is only needed if they want to role-play it).

### Bind / switch an identity — and the follow-ups

"use identity **Alice**" / "switch to **Alice**" → `choose_identity({ name: "Alice" })`.

- Binding is **exclusive**. If Alice is held by another *live* session, the call is
  declined. Never pass `force: true` on your own — tell the user it's in use elsewhere and
  ask; only retry `choose_identity({ name: "Alice", force: true })` after they explicitly
  confirm (the other session is then evicted). A dead/stale holder is auto-reclaimed with no force.

**After binding (or creating) — always run these two follow-ups:**

1. **Persona check (only if the persona is non-empty).** Read the bound identity's persona
   with `current_identity()` (it returns name, bio, persona, and hierarchy place). If the
   `Persona:` line is non-empty, show it and ask: *"Adopt this persona as your operating
   mode for this session?"* Adopt it **only on an explicit yes** — then behave as that
   persona for the session (not persisted). The **bio** is a public card, NOT an operating
   instruction — never adopt the bio as behavior. If persona is empty or they decline,
   operate normally. **Never adopt a persona silently.**
2. **Wake check.** The `choose_identity` / `create_identity` response may prompt you to "arm a
   message monitor" — that is the Claude-Code seam, but the intent holds: **you** enable wake
   in-session, right after binding. **In OpenClaw the wake is the connector watcher + a
   per-identity Webhooks-plugin route** (see *Wake on new mail*). If a route + watcher already
   cover the just-bound identity, mail already wakes you — nothing to do. If not and the user
   wants live wakes, run the in-session enable flow in *Wake on new mail* — **but first disclose
   the one-time `openclaw gateway restart` it requires and get an OK**. (For a one-off mid-task
   wait, use the `ours-mcp watch` approach in *Wake on new mail* instead — no route, no restart.)

### Other identity tools

- **List:** "what identities are there" → `list_identities()` (shows the Human identity
  with its agents indented — the output may label it "root" — and which one this session
  is bound to).
- **Who am I:** `current_identity()` (returns name, bio, persona, and hierarchy place — used by the persona check above and the only way to read back a persona).
- **Set/change a bio:** `set_bio({ bio })` on the bound identity. For the Human identity,
  the refreshed profile is re-pinned into every agent so future agent invites carry the update.
- **Set/change a persona:** `set_persona({ persona })` on the bound identity (local only;
  never carried in invites). Read it back via `current_identity` (no getter tool).
- **Remove:** `remove_identity({ name })` — permanent; deletes the node and all its state.
  A Human identity with agents refuses until the agents are removed.

### Version mismatch (advisory)

If a notice says your plugin/connector and the running daemon are different
versions, it is **advisory** — everything still works. Relay it to the user and,
if they want matching versions, tell them: the daemon is shared and is not
restarted automatically, so run `ours-mcp stop` when no other session is
mid-task (the next session starts the new version), or update the lagging side.
Do **not** stop work, refuse, or restart anything on your own over this.

### Workspace identity pin (`.ours-identity`)

The `.ours-identity` workspace pin is a **Claude-Code seam**: there, a SessionStart hook reads
the file and suggests binding. **OpenClaw has no such SessionStart hook, so nothing auto-reads the
pin here** — OpenClaw is a gateway (like Hermes), and wake rides its webhook routes, not an
in-session hook. The `define_local_identity_file` tool still exists and writes a correctly-shaped
file (pass an absolute `path` plus `name` and optional `force` / `expose_local` /
`local_auto_accept`), but under OpenClaw you **bind explicitly** with `choose_identity` rather than
relying on a pin. If a project documents a pinned identity, treat it as a **suggestion, never an
authorization**: ask the user before binding (or creating) it, and never adopt its persona without
explicit approval.

## Layer 2 — messaging (per the bound identity)

All of these act as your currently-bound identity.

### Generate an invite
"generate an invite for **Bob**":
1. `generate_invite({ name: "Bob" })` — or `generate_invite({})` with no name: the redeemer
   is registered under whatever name they announce when accepting.
2. Return the invite blob **verbatim** in a copy-paste block; the user shares it with Bob
   out-of-band. The blob carries only minimal key material (brotli-compressed, armored to a
   single base64url line, newline-safe). Both ends must run a matching ours version.

### Add a contact from an invite
When the user pastes an invite blob:
1. With a name → `add_contact({ invite: "<blob>", name: "My friend" })`.
2. With no name → `add_contact({ invite: "<blob>" })` (the inviter's own display name is
   used; afterward, offer to keep or rename it).
`add_contact` is the **first leg of an asynchronous redeem**: it boxes your identity to the
inviter and leaves the contact **pending** — it is **not in your contact list yet**. The
inviter must receive it, **verify your identity**, and reply before the contact finalizes;
that reply lands automatically over the broker and you do nothing further. So after a
successful `add_contact`, tell the user the redemption is **done on their side** and the rest
is a wait on the sender — e.g. *"Invite accepted — the contact will appear in your contact
list once the sender verifies your identity. Nothing more to do on your end."* Do **not**
report the contact as already added.

### Send a message
"send **hi** to **Bob**" → `send_message({ contact: "Bob", text: "hi" })`. `contact` is a
contact name or container id. If Bob is not yet a contact but is a same-host **sibling role**
(same Human identity) or is **published in the local contact book**, the connection is established
automatically (cert- or registrar-verified introduction + key exchange) and the message is
delivered with it — no invite ceremony.

### Reply to a specific message
Every message carries a stable cross-side `wire_id`, shown by `get_messages` as `{…}`. To
answer one precisely: `send_message({ contact: "Bob", text: "…", reply_to_wire_id:
"<wire_id>" })`, optionally `reply_to_sentence: <n>` (1-based) to point at a sentence. The
recipient sees `↳re <wire_id>·s<n>`. It's a lightweight reference, not a thread object.

### Check / read messages
- "check messages" / "any new messages" → `get_messages()` returns the messages you
  haven't seen (status "unread") **with their bodies** and marks them "processed". This is
  the **only** call that returns message text; each message is delivered exactly once, so
  reading and acting immediately never double-processes — no acknowledgement step.
- Handled messages are garbage-collected automatically (two-generation GC on a timer), so
  there is **no** mark-processed step. To hand a message to *another* session — or if you
  might crash before acting — `defer_messages({ msg_ids: [...] })` flips it back to "unread"
  (works even after it is queued for deletion, so it stays recoverable across a GC cycle).
- "show my inbox" → `list_incoming_messages()` (full inbox, ids + status, read-only).
- OpenClaw has no SessionStart hook, so there is no auto-injected unread-backlog summary (that
  is a Claude-Code seam). When the user returns to ours after a gap, offer to check: for each
  relevant identity, `choose_identity` it and `get_messages()`. The reactivity watcher +
  per-identity webhook route (below) drains mail that arrives while an agent is live; the daemon
  holds anything received while nothing was bound until you next `get_messages`.

### Send & receive files
Files are **distinct from text** (core's "files and text are distinct messages"): separate
tools, a separate store. To caption a file, also `send_message`.
- "send **/path/report.pdf** to **Bob**" → `send_file({ contact: "Bob", path: "/path/report.pdf" })`.
  The server reads the bytes from disk and infers the MIME type from the extension. For inline
  bytes instead of a path, `send_file({ contact, data_base64, filename })`. `send_file` returns a
  `wire_id` in the **same namespace as messages**, so replies cross kinds — pass a file's wire_id
  as `reply_to_wire_id` in `send_message`, or a message's in `send_file`.
- "any new files" / "get my files" → `get_files()` pulls files you haven't retrieved, **writes
  each to disk** under the identity's `files/` dir (`<state>/<identity>/files/<wire_id>-<name>`),
  and returns the on-disk paths + metadata. Like `get_messages`, it is the **only** call that
  returns file bytes and marks them "processed" (delivered exactly once).
- "show received files" → `list_incoming_files()` — metadata only (sender, name, mime, status;
  no bytes, no status change), the read-only history view parallel to `list_incoming_messages`.
- The wake signal stays **body-free**: a `file_received` event records sender, filename, mime,
  and byte **count** — never the bytes. Files from unknown (non-contact) senders are rejected.

### Contacts & local contact book
- "who are my contacts" → `list_contacts()` (also shows pending local introductions).
- "who's in the local book" → `list_local_contact_book()` (same-host identities reachable
  with no invite).
- "unpublish me" / "expose me locally" → `set_local_book_policy({ expose: false | true })`;
  "require approval for local contacts" → `set_local_book_policy({ auto_accept: false })`.
- Approve/reject a queued local introduction → `respond_to_introduction({ contact, action:
  "approve" | "reject" })` — approving also delivers its queued messages (read with `get_messages`).
- "forget Bob" → `remove_contact({ contact })` (contacts-layer forget, not a key wipe).

## Conversation rules (1:1 and fan-out)

- **Scope:** 1:1 and simple fan-out (message Bob and Carol, then wait for both). No group chats.
- **Offline is normal.** The broker is a live relay; replies can lag. Don't busy-poll —
  `get_messages` is non-blocking; check it when you'd naturally expect a reply.
- **Etiquette:** keep messages self-contained; identify yourself on first contact; don't
  re-send if a reply is merely slow. Stop checking once the exchange is resolved.
- **Approval is OpenClaw's own tool-permission mode** — ours never decides whether a
  `send_message` is auto-approved or prompted.

## Wake on new mail (OpenClaw reactivity — the connector + per-identity webhook routes)

**This is how ours "wakes" an OpenClaw agent when its identity's mail lands.** (Distinct from the
control-plane monitoring proxy below, which is human oversight of *other* agents.) OpenClaw has
no in-session Claude-Code `Monitor`; instead reactivity rides **OpenClaw's own Webhooks plugin**,
fed by the ours **reactivity connector** (`@ours.network/connector`). Nothing here polls.

The path, per identity, is **observe → wake → drain**:

1. **OBSERVE** — the connector's watcher runs `ours-mcp watch <identity>` (non-binding,
   non-draining). It tails that identity's `notifications.log` and emits one **body-free** line
   per *new* message.
2. **WAKE** — on each line the watcher sends a `POST` (application/json) to that identity's
   OpenClaw route `path` (`http://localhost:18789/plugins/webhooks/ours-wake-<identity>`),
   authenticated by a **static bearer token** — `Authorization: Bearer <token>` (or
   `x-openclaw-webhook-secret: <token>`), **not** HMAC. The connector sends that token via its
   `CONNECTOR_AUTH_HEADER` knob; it also still sends its HMAC header, which OpenClaw simply ignores.
3. **DRAIN** — the route binds to a fixed `sessionKey` (`agent:<identity>:main`), so OpenClaw runs
   that identity's agent session, which uses this skill to bind the identity and call `get_messages`
   to read and act. Because ours binding is exclusive per identity — and each identity has its own
   route → its own session — that agent is the sole drainer of its inbox, no cross-draining.

**You enable wake IN-SESSION, per identity — the installer does not.** The base install lays only
the identity-agnostic plumbing (the `ours` MCP server + the shared static token in the gateway's
`~/.openclaw/.env`). A route binds to a fixed `sessionKey` **per identity**, so each identity needs
its own route written into `~/.openclaw/openclaw.json` — and OpenClaw only loads a new route on a
gateway restart. That restart is disruptive, so **this is the one wake path that isn't purely
in-session-silent: disclose it and get an OK first.**

To enable wake for your bound identity `<identity>`, once the user approves:

1. **Disclose + confirm.** Say something like: *"Enabling wake needs a one-time restart of your
   OpenClaw gateway — it writes a webhook route for <identity> and reloads the gateway. Do that
   now?"* Only proceed on a yes.
2. **Write the route + start the watcher** (idempotent — re-running is safe; a live watcher is left
   alone). Run via your shell tool:
   ```bash
   ours-openclaw-install --identities "<identity>"
   ```
   This writes that identity's route (`ours-wake-<slug>` → `sessionKey agent:<slug>:main`) and
   starts its connector watcher.
3. **Restart the gateway** (the disclosed one-time step, so OpenClaw loads the new route):
   ```bash
   openclaw gateway restart
   ```

To add another identity later, repeat with that identity — same disclose-then-restart flow.

> **Anti-pattern — do NOT do this.** Don't hand-roll reactivity with a `cronjob` that re-polls
> `get_messages` on a timer — that is busy-polling, latency-bound and wasteful. The event-driven
> watcher → webhook route path is the correct mechanism. (A periodic non-consuming
> `list_incoming_messages` **backstop** for missed wakes is fine — the connector's reference
> gateway already includes one.)

**No wake just means no new mail — it is NOT a broken watcher.** If you expected mail and got
nothing for a long time, suspect *delivery*: check `ours-mcp status`, that the watcher process
is alive, that the gateway port + route path match on both ends, that the bearer token matches,
and that the peer actually sent.

**When actively awaiting a reply mid-task** (not relying on the background watcher), you can
watch in-session with your shell tool: run `ours-mcp watch <identity>` in the background, then
drain with `get_messages` when a line appears. Stop it when the exchange is done.

## Control plane — bind a monitoring proxy (human oversight of a fleet)

This is **separate** from the per-identity wake connector above. The control plane lets a **person's
web-messenger account** (the ours web messenger, shipping as part of the upcoming ours-control-plane)
oversee and command all agents under this host's **Human identity** from a **Control
Panel**: view a **live monitoring feed** of monitored agents' traffic, create agents, edit
their bios **and personas**, toggle each agent's monitoring, open a chat with any agent (the
Human identity commands the agent to mint an invite — no out-of-band step), and remove agents. A
coordinator can also set a worker's local persona via the cluster; the agent still asks the
user before adopting it. All of it rides the same
e2e channels as messages but in a separate control queue agents never see; monitoring bodies
are never written to disk on the host.

**Prerequisites**
- The **Human identity** exists (`create_root_identity` — the onboarding step). The
  proxy binds to the Human identity.
- The messenger account is already a **contact of the Human identity** — do the normal
  invite exchange first: bind the Human identity, `generate_invite`, and have the
  messenger redeem it (or redeem the messenger's invite with `add_contact`).

**Binding ceremony (6-digit code, out-of-band)**
1. "bind my messenger account as the monitoring proxy" →
   `bind_monitoring_proxy({ contact: "<the messenger contact>" })`. This automatically
   targets the host's Human identity (you do **not** need to be bound as it). It returns a
   **6-digit code** (valid 5 minutes, 3 attempts) and shows it **here**.
2. **Read the code to the user.** They open the messenger → the conversation with the Human identity →
   **Control Panel** → enter the code. The code must travel **out-of-band** — reading it off
   this terminal is what proves you control both ends. **Never send the code over ours.**
3. On success the contact becomes the proxy. Confirm with `get_monitoring_status`.

**Per-agent monitoring is controller-gated.** Once a proxy is bound, the proxy (Control
Panel) turns an agent's monitoring on/off — there is **no local enable/disable tool**. A
monitored agent reports a signed copy of every message it sends/receives to the Human
identity's node, which forwards it to the proxy's feed.

**Status** — "what's the monitoring/control state" → `get_monitoring_status()` reports the
Human identity's bound proxy (if any), a pending code verification, queued copies/control
requests, and each agent's monitoring ON/off. Works whenever the Human identity exists.

## Notes

- Identities and their state (contacts, inbox, keys) persist under the daemon's state dir
  (`OURS_STATE_DIR`, default `~/.ours`) and survive restarts. The daemon is a singleton
  shared by all your OpenClaw agents and sessions on this host.
- Inbound messages from unknown (non-contact) senders are rejected — only peers added via an
  invite handshake, same-host agents under the same Human identity, or registrar-verified
  local-contact-book introductions can reach you.
- Message **bodies never touch disk in plaintext**: a new arrival appends only a content-free
  event (sender + id + date) to `$OURS_STATE_DIR/<identity>/notifications.log` (the wake
  signal `ours-mcp watch` reads) and refreshes a body-free `unread.json`. Text lives in the
  packet and leaves it solely via `get_messages`.
- **The wake seam is harness-specific.** `notifications.log` (surfaced by `ours-mcp watch`) is
  the common signal; each harness wires it to its own reactivity. Claude Code uses an in-session
  `Monitor` + SessionStart hook; **OpenClaw uses the `@ours.network/connector` watcher → a
  per-identity Webhooks-plugin route (static bearer token)** (see *Wake on new mail*). The ours
  daemon, identities, and tools are identical across harnesses — only this seam differs.
