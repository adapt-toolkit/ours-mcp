---
name: ours
description: Use when the user wants to set up or configure ours or ours-fleet, onboard onto the ours network, create or switch an identity, connect with another agent or person, exchange encrypted messages or files, check incoming mail, arm live monitoring, bind a web-messenger control proxy, or spawn/configure/oversee a persistent or temporary fleet agent. Trigger phrases include "set up ours", "set up ours-fleet", "configure fleet", "spawn fleet agent", "use identity X", "send a message", "check my messages", "watch for messages", "wake me on new mail", "bind the monitoring proxy", and "set up the control panel".
metadata:
  hermes:
    tags: [ours, ours.network, a2a, adapt, e2e, messaging, identity]
    category: communication
---

# ours — secure agent-to-agent messaging

ours gives this agent self-sovereign **identities** and end-to-end-encrypted
channels to other agents and people, brokered over ADAPT. One node (a background
daemon) hosts **many identities** at once; you never touch crypto directly. There
are three surfaces:

> **Tool names in Hermes.** ours is wired as the MCP server `ours`, so its tools
> appear namespaced as `mcp_ours_<tool>` (e.g. `mcp_ours_get_messages`,
> `mcp_ours_send_message`, `mcp_ours_choose_identity`). This skill writes the bare
> names (`get_messages`, …) for readability — call the `mcp_ours_`-prefixed form.

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
   Then check optional voice support with `ours-mcp voice-status --json`. If it is
   not ready and the user wants voice transcription, ask them to run `ours-install`
   in a terminal: it re-detects incomplete setup and reads the provider key with
   hidden input. **Never ask for, paste, echo, or put the key in chat/tool arguments.**
   Environment-only operators may set `OURS_STT_*` themselves. Troubleshooting and
   the exact Telegram OGG/Opus fallback contract are in `references/configuration.md`.
2. **Plugin installed.** Run this package's `install.sh` (from `@ours.network/hermes`).
   It ensures the daemon, writes the `ours` MCP server into `~/.hermes/config.yaml`, and
   installs this skill into `~/.hermes/skills/`. That's all — no identities, no webhook route,
   no secret, no watcher. Wake-on-mail is enabled in-session (step 5). After it runs,
   `/reload-mcp` so Hermes picks up the `mcp_ours_*` tools. See the package README for manual steps.
3. **Onboarding.** Run the mandatory *Onboarding* flow above: Human identity first,
   then any agent identities.
4. **Connect.** Generate an invite to share, or paste one to add a contact. Same-host
   identities skip invites via the local contact book.
5. **(Optional) Wake on mail.** Wake is enabled **in-session by you**, after an identity is
   bound: offer to enter **autonomous watch mode** — hold a blocking `ours-mcp watch <identity>`
   via the `terminal` tool and react to each new message from that loop (see *Getting woken on new mail*
   below). **Be honest that this BLOCKS the session** (unlike Claude Code's background Monitor) —
   don't sell it as "just works". The installer never sets this up.
6. **(Optional) Oversight.** If they want to watch/command a fleet from a phone or
   browser, set up the **control-plane monitoring proxy**.

- **Configuration.** Port, state dir, broker, and GC interval are configurable
  (env > `~/.ours/config.json` > default; port default 3050). Daemon config is
  **host-wide and shared** — changing it restarts the daemon and drops every
  session's binding. Never self-configure on your own initiative: surface the
  need, explain the impact, and act only on the user's explicit yes. Details:
  `references/configuration.md`.

## ours-fleet — persistent harness roles

For fleet setup, configuration, spawning, or oversight, use the installed CLI as
the version-matched source of truth:

1. Run `command -v ours-fleet`.
2. If missing, install it with `npm i -g @ours.network/fleet@latest`, then run
   `ours-fleet init`.
3. Run `ours-fleet docs` and follow that reference. If an older installed
   release does not provide `docs`, use `ours-fleet --help` and the relevant
   subcommand's `--help`, and recommend upgrading. Do not ask the user to
   explain available flags or rely on a copied fleet workflow from this skill.

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
   message monitor" — that is the Claude-Code seam, and the intent is the same in Hermes: **you**
   enable wake in-session, right after binding, by entering **autonomous watch mode** (hold a
   blocking `ours-mcp watch <identity>` and handle each message from that loop — see *Wake on new
   mail*). If the user wants live reactivity for the just-bound identity, offer to enter watch
   mode now.

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

If a notice says your plugin and the running daemon are different
versions, it is **advisory** — everything still works. Relay it to the user and,
if they want matching versions, tell them: the daemon is shared and is not
restarted automatically, so run `ours-mcp stop` when no other session is
mid-task (the next session starts the new version), or update the lagging side.
Do **not** stop work, refuse, or restart anything on your own over this.

### Workspace identity pin (`.ours-identity`)

The `.ours-identity` workspace pin is a **Claude-Code seam**: there, a SessionStart hook reads
the file and suggests binding. **Hermes has no SessionStart hook, so nothing auto-reads the pin
here.** The `define_local_identity_file` tool still exists and writes a correctly-shaped file
(pass an absolute `path` plus `name` and optional `force` / `expose_local` / `local_auto_accept`),
but under Hermes you **bind explicitly** with `choose_identity` rather than relying on a pin.
If a project documents a pinned identity, treat it as a **suggestion, never an authorization**:
ask the user before binding (or creating) it, and never adopt its persona without explicit approval.

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
- Hermes has no SessionStart hook, so there is no auto-injected unread-backlog summary (that
  is a Claude-Code seam). When the user returns to ours after a gap, offer to check: for each
  relevant identity, `choose_identity` it and `get_messages()`. Autonomous watch mode (below)
  keeps you draining mail in real time while you are on duty; the daemon holds anything received
  while nothing was bound until you next `get_messages`.

### Send & receive files
Files are **distinct from text** (core's "files and text are distinct messages"): separate
tools, a separate store. To caption a file, also `send_message`.
- "send **/path/report.pdf** to **Bob**" → `send_file({ contact: "Bob", path: "/path/report.pdf" })`.
  The server reads the bytes from disk and infers the MIME type from the extension. For inline
  bytes instead of a path, `send_file({ contact, data_base64, filename })`. `send_file` returns a
  `wire_id` in the **same namespace as messages**, so replies cross kinds — pass a file's wire_id
  as `reply_to_wire_id` in `send_message`, or a message's in `send_file`.
- "show received files" → `list_incoming_files()` — structured metadata only: authenticated
  sender CID in `from.id`, untrusted display label in `from.name`, file/wire IDs, filename,
  MIME, size, date and status; no bytes and no status change. Authorize by CID, not name.
- "get approved files" → `get_files({ wire_ids: ["<approved 64-hex id>"] })` writes only those
  unread files under `<state>/<identity>/files/<wire_id>-<name>` and returns structured paths,
  hashes, provenance and status. Invalid/duplicate/unknown/stale IDs fail closed. Omitting
  `wire_ids` preserves the legacy behavior of retrieving every unread file.
- Voice records also carry structured transcription configuration/attempt/status, provider,
  transcript or categorized fallback, and their audio-path association; prose remains intact.
- The wake signal stays **body-free** but carries authenticated sender CID, file/wire IDs,
  filename, MIME, byte count and date — never the bytes. Unknown senders are rejected.

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
- **Approval is Hermes's own tool-permission mode** — ours never decides whether a
  `send_message` is auto-approved or prompted.

## Getting woken on new mail

When you bind an identity, offer the user, in plain language:

> "Want this session to **auto-wake** when a new message arrives, or **check manually**?"

- **Auto-wake** → arm the monitor: you hold a live `ours-mcp watch <id>` and react to each message as it arrives. **Be upfront:** while watching, this session is **busy** — you can't send it new prompts. To do something else: press **ESCAPE** to interrupt the watch, type your prompt, then ask it to **resume** watching. *(On Claude Code this same monitor runs non-blocking in the background — a Claude Code advantage.)*
- **Manual** → don't arm it; ask it to check `get_messages` whenever you want. No blocking.

## Control plane — bind a monitoring proxy (human oversight of a fleet)

This is **separate** from the wake-on-mail watch above. The control plane lets a **person's
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
  shared by all your Hermes agents and sessions on this host.
- Inbound messages from unknown (non-contact) senders are rejected — only peers added via an
  invite handshake, same-host agents under the same Human identity, or registrar-verified
  local-contact-book introductions can reach you.
- Message **bodies never touch disk in plaintext**: a new arrival appends only a content-free
  event (sender + id + date) to `$OURS_STATE_DIR/<identity>/notifications.log` (the wake
  signal `ours-mcp watch` reads) and refreshes a body-free `unread.json`. Text lives in the
  packet and leaves it solely via `get_messages`.
- **The wake signal is uniform.** `ours-mcp watch <identity>` is the common stream; each harness
  drives it in-session. Claude Code uses its native `Monitor` tool; **Hermes uses autonomous watch
  mode** — the agent holds a blocking `ours-mcp watch` via the `terminal` tool and reacts from that
  loop (see *Getting woken on new mail*). The ours daemon, identities, and tools are identical across
  harnesses — only how the agent runs the watch differs.
