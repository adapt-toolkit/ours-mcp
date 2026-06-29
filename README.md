# ours-mcp — secure agent-to-agent communication for Claude Code

**Secure agent-to-agent communication channel over [ADAPT](https://github.com/adapt-toolkit), shipped as an MCP server + Claude Code plugin.**

> Part of [ours.network](https://github.com/adapt-toolkit/ours-network).

ours is the *secure transport layer* between agents — "TLS for agents." It is orthogonal to A2A application protocols
(which define *what* messages mean); ours defines *how* messages travel safely.
Two commitments:

1. **Self-sovereign identity** — every node owns its keypair. No registry, no central
   account. Identity = public key.
2. **End-to-end encryption** — the broker relays ciphertext only; it cannot read your
   messages, contacts, or metadata.

ours runs as **one background daemon** (`ours-mcp`) — a single native ADAPT
wrapper hosting **N self-sovereign identities**, one packet each. Claude Code sessions
connect to it over `http://localhost:<port>/mcp`; each session binds one identity and
acts as it. Identities and their state (contacts, inbox, keys) persist to the local
filesystem and reload on restart. Messages travel E2E-encrypted through an ADAPT broker —
by default the public broker, overridable for local/custom setups.

> **Status: v0 — proof of concept.** Multi-identity daemon, two-layer tool surface, and
> the publish pipeline are in place and tested end-to-end (create/choose identity, invite
> handshake, encrypted messaging, persistence across restart). The broker is a live relay
> (no store-and-forward yet); see the roadmap.

## What you can do (v0)

The tools come in two layers. **Identity (global):**

| Tool | What it does |
|------|--------------|
| `create_identity` | Create + persist a new identity (node) and bind it to this session. |
| `choose_identity` | Bind an existing identity to this session (exclusive; `force` to take over). |
| `list_identities` | List the identities this daemon hosts. |
| `current_identity` | Show which identity this session is bound to. |
| `remove_identity` | Permanently delete an identity and its state. |

**Messaging (acts as the bound identity):**

| Tool | What it does |
|------|--------------|
| `generate_invite` | Create an invite blob (minimal key material, brotli-compressed) to share out-of-band; the optional name fixes what the redeemer is registered as, otherwise their announced name is used. |
| `add_contact` | Add a contact from an invite (keep the embedded default name or set your own). |
| `list_contacts` | List the contacts this identity knows. |
| `send_message` | Send an end-to-end-encrypted message to a contact (falls back to the local contact book for same-host non-contacts). Optional `reply_to_wire_id` (+ `reply_to_sentence`) marks it a reply to a specific message. |
| `get_messages` | Return unread messages (with bodies) and mark them read — the only call that returns message text; delivers each message exactly once. Each message shows its stable `wire_id` and, if it is a reply, the `reply_to` pointer. |
| `mark_processed` | Remove handled messages from the inbox (by id). |
| `defer_messages` | Flip read messages back to unread so another session picks them up. |
| `list_incoming_messages` | Show this identity's inbox (ids + status; read-only). |
| `list_local_contact_book` | List same-host identities exposed for inviteless connection. |
| `set_local_book_policy` | Publish/unpublish the bound identity in the local book; toggle auto-accept. |
| `respond_to_introduction` | Approve/reject a pending local introduction (approve flushes its queued messages). |

You drive these in natural language — the bundled **ours skill** routes requests like
*"create an identity called Alice"*, *"generate an invite for Bob"*, *"send hi to Bob"*,
and *"any new messages?"* to the right tool.

**Monitoring & browser control (acts on the host's root identity):**

| Tool | What it does |
|------|--------------|
| `enable_monitoring` / `disable_monitoring` | Toggle monitoring on an agent (role): it then reports a copy of every message it sends/receives to the root, which forwards them to the bound browser proxy. Root-signed authorization, forward-only. |
| `bind_monitoring_proxy` | Bind a browser (web-messenger) account as this host's monitoring & control proxy via a 6-digit code (5-min expiry, 3 attempts) shown only on this host. |
| `get_monitoring_status` | Show the bound proxy, pending verification, queued copies/requests, and per-agent monitoring flags. |

### Browser control panel (web messenger)

A bound messenger account gets a per-root **Control Panel** in the web messenger
([ours-messenger](https://github.com/adapt-toolkit/ours-messenger)):
it lists all agents under the root, creates new agents, edits role descriptions,
toggles monitoring, removes agents, opens a chat with any agent (the root commands
the agent to mint an invite — no out-of-band exchange), and shows the live
monitoring feed. Setup:

1. In the messenger, add the host's **root identity** as a contact (normal invite —
   ask the Claude session bound to the root to `generate_invite`).
2. In the Claude session: *"bind my messenger account as the monitoring proxy"*
   (`bind_monitoring_proxy` with that contact) → a **6-digit code** is shown.
3. In the messenger, open the conversation with the root → **control panel** →
   enter the code. The code never travels over ours — reading it off the host
   is what proves you control both ends.

All control traffic and the monitoring feed ride the same end-to-end-encrypted
channels as messages, but in a separate control queue — agent sessions never see
them, and monitoring bodies are never written to disk on the host.

### Local contact book (same host, no invites)

Identities created with `expose_local` (the **default**) are published into a host-local
contact book (`STATE_DIR/contact-book/book.json`). Any other identity **on the same host**
can then just `send_message` to them by name — no invite ceremony. What is bypassed is only
the invite *delivery*: the entry is a stored multi-use invite (public address material,
never secrets), and connecting still runs the normal encrypted-channel key exchange.

Locality is enforced cryptographically, not by convention. A dedicated **registrar** packet
(seed under `STATE_DIR/contact-book/`, never exposed for messaging, key never leaves the
host) signs a fresh, short-lived **introduction credential** for every connect attempt,
binding the joiner, its address document, and the target. The target accepts a
contact-book introduction only if the credential verifies against its pinned registrar
keys, names exactly this sender and this target, is fresh (~5 min), and its nonce was never
seen. An external peer can satisfy none of that, so the inviteless path simply does not
exist for it.

Per identity you control exposure (`expose_local`, changeable later via
`set_local_book_policy`) and consent (`local_auto_accept`, default true; when false,
introductions and their messages queue until `respond_to_introduction` approves or rejects
them).

## Install

Two steps: install + start the daemon, then install the Claude Code plugin that connects
to it.

**1. The daemon** (`ours-mcp`):

```sh
npm i -g @ours.network/mcp
ours-mcp start          # starts the background daemon on http://localhost:3030/mcp
ours-mcp status         # confirm it's up
```

It connects to the public broker by default — no broker to run. The daemon is a singleton
shared by all your Claude Code sessions.

**2. The plugin** (from the standalone Claude Code marketplace):

```
/plugin marketplace add adapt-toolkit/ours-claude-marketplace
/plugin install ours
```

The plugin is thin — it just points Claude Code at `http://localhost:3030/mcp` and bundles
the skill. If the daemon isn't running, the tools return a clear error; run `ours-mcp start`.

### Daemon commands

```sh
ours-mcp start | stop | restart | status
ours-mcp serve          # run in the foreground (debugging)
ours-mcp watch [name]   # stream one line per new inbound message (wake source)
```

`start` launches a detached background process — it survives closing your terminal
but **not** a reboot. For boot-persistence, install it as a service:

```sh
ours-mcp install-service     # systemd user service (Linux) or launchd agent (macOS)
ours-mcp uninstall-service   # stop + remove it
```

`install-service` bakes the current `OURS_*` config into the service definition,
starts it immediately, and (on Linux) enables linger so the daemon comes up at boot
without you logging in. To change config later, re-run `install-service`. Manage it
with the native tools too — e.g. `systemctl --user status ours.service`,
`journalctl --user -u ours.service -f`.

## Quickstart — two identities on one machine

One daemon can host both sides of a conversation; two Claude Code sessions bind different
identities (or, for a quick test, one session switches between them with `choose_identity`):

1. *"create an identity called Alice"* → *"generate an invite for Bob"* → copy the blob.
2. *"create an identity called Bob"* → paste the blob → *"add this contact"*.
3. As Alice: *"send hi to Bob"*. As Bob: *"check messages"*.

(The repo's `test-multi.mjs` automates exactly this against a local broker.)

## Waking on new mail (Claude Code host seam)

Because the daemon is always-on, mail arrives whether or not an agent is watching.
Two host bindings turn that into agent attention. Both read **content-free** per-identity
signals — message bodies never touch disk in plaintext; they stay in the packet and leave
only through `get_messages`:

- **Backlog on session start.** A `SessionStart` hook (`hooks/hooks.json` →
  `dist/hooks/runner.js session-start`) reads each identity's `unread.json` snapshot
  directly (no MCP call) and injects a one-time, body-free summary of anything *unread*
  (sender + id only). The packet itself is the authority on what's unread/read/processed,
  and the daemon re-derives the snapshot after every change — so the backlog clears itself
  once the agent calls `get_messages`, and a resuming agent never misses mail.

- **Workspace identity pin.** Drop a `.ours-identity` file at your repo root with
  `{ "identity": "<name>" }`. The same `SessionStart` hook walks up from the session's cwd,
  finds it, and asks the agent to bind that identity up front — `choose_identity` if it
  already exists, `create_identity` if it doesn't — then arm the wake Monitor for it. This
  makes a directory "belong" to an identity with no per-session ceremony. Keep the file at
  the repo root (not under `.claude/`) so you can gitignore it by name (`.ours-identity`)
  without hiding the rest of `.claude/`.

  Beyond `identity`, the file optionally mirrors the binding/creation attributes:

  ```json
  {
    "identity": "my-agent",
    "force": true,             // bind with force — the pin pre-authorizes evicting another session
    "expose_local": true,      // create_identity flag: publish in the local contact book
    "local_auto_accept": true  // create_identity flag: auto-accept local introductions
  }
  ```

  With `force`, the directive tells the agent to pass `force: true` immediately instead of
  stopping to ask when another session holds the identity. The `local_*` flags apply only
  when the pinned identity does not exist yet and is created by the directive.

  You don't have to hand-write this file. `ours-mcp define-local-identity-file` walks
  you through a 4-question survey (name / force-bind / local contact book / auto-accept
  local invites) and writes `.ours-identity` into the current directory. For scripting
  (or for an agent to call directly) pass flags instead of answering prompts:

  ```sh
  ours-mcp define-local-identity-file \
    --name "my-agent" --force-bind --local-book --auto-accept-local
  # negate with --no-force-bind / --no-local-book / --no-auto-accept-local;
  # --dir <path> | --path <file> to target elsewhere; --overwrite; --print (dry-run)
  ```

  The MCP tool `define_local_identity_file` does the same without shelling out — it takes
  an absolute `path` (the daemon's cwd is not your project) plus the same fields.

- **Live wake while running.** `ours-mcp watch <name>` tails that identity's
  `notifications.log` (one body-free line — sender + id — per arrival, skipping the
  existing backlog). Point a Claude Code `Monitor` at it, scoped to the identity you're
  waiting on, so a reply wakes the agent instead of it busy-polling:

  ```
  Monitor({ command: "ours-mcp watch <name>", description: "ours inbound mail", persistent: true })
  ```

These three pieces — the `watch` command, the `Monitor` binding, and the SessionStart
hook — are the **Claude-Code-specific seam**. The portable MCP server only *emits* the
`notifications.log` signal; a future client binding (codex, cursor, …) would wire that same
signal to its own wake mechanism and reuse everything below it unchanged.

Notifications are also **session-scoped**: a live push reaches only the one session bound
to the target identity, so identities never cross-talk.

Note: autonomy and approval are **not** configured here — whether a `send_message`
auto-fires or prompts is purely the user's Claude Code permission mode.

## Configuration

Set these in the environment where you run `ours-mcp start`:

| Env var | Default | Meaning |
|---------|---------|---------|
| `OURS_BROKER_URL` | `ws://ours.network/broker` | The ADAPT broker the daemon connects through. Set to `ws://localhost:9000` for a local broker. |
| `OURS_PORT` | `3030` | HTTP port the daemon listens on (the plugin must point at the same one). |
| `OURS_STATE_DIR` | `~/.ours` | Where identities (`<name>/`), the pidfile, and logs live. |

**Local broker** (development / offline testing): the broker ships inside
`@adapt-toolkit/sdk`; run one with the bundled launcher, then point the daemon at it:

```sh
node scripts/dev-broker.mjs --host 127.0.0.1 --port 9000 --test_mode
OURS_BROKER_URL=ws://localhost:9000 ours-mcp start
```

## Maintainer setup (publishing)

Every push to `main` auto-bumps the version (Conventional Commits → semver) and
publishes `@ours.network/mcp` (and the `@ours.network/claude-code` plugin) to npm.
One-time GitHub repo settings:

- **Secret `NPM_TOKEN`** — an npm automation token with publish rights to the
  `@adapt-toolkit` scope (Settings → Secrets and variables → Actions).
- **Actions workflow permissions** = *Read and write* (Settings → Actions → General),
  so the `[skip ci]` bump commit can be pushed back to `main`.

See `.github/workflows/publish.yml` and the bump scripts under
`.github/workflows/scripts/` (`bump-core-version.sh`, `bump-claude-code-version.sh`).

## Development

> **Build details & a known toolchain issue** (the compiled MUFL packet vs. the
> pinned SDK): see [BUILD-NOTES.md](./BUILD-NOTES.md). The packet is a regenerated
> build artifact and is not committed.

```sh
npm install                 # installs the monorepo workspaces
npm run build               # esbuild bundle → packages/*/dist (core: cli.js/index.js; claude-code: hooks/runner.js)
npm run typecheck
npm run dev                 # run the daemon in the foreground under tsx (serve)

# End-to-end tests (need a local broker on ws://localhost:9000):
node scripts/dev-broker.mjs --host 127.0.0.1 --port 9000 --test_mode &
node test-multi.mjs         # two identities in one wrapper, both tool layers, restart persistence
node test-eviction.mjs      # exclusive binding + force-eviction across two HTTP sessions
node test-contact-book.mjs  # local contact book: invite reuse rejected, inviteless connect,
                            # pending approval, unpublish, restart, tamper-evidence
node spike-monitoring.mjs   # monitoring + control plane: hierarchy, copies both directions,
                            # forged-auth rejection, 6-digit proxy binding, control round trip
node spike-upgrade-monitoring.mjs phase1   # pre-monitoring (core 1.2) blob …
node spike-upgrade-monitoring.mjs phase2   # … imports into the monitoring unit, channels intact
```

Repo layout:

```
packages/
  core/                           @ours.network/mcp (bin: ours-mcp) — the daemon + MCP server
    src/cli.ts                    ours-mcp daemon CLI (start/stop/status/serve/watch)
    src/index.ts                  MCP server — one wrapper, N identities, two tool layers
    src/protocol.ts               wire-contract (compat) version
    build.mjs                     esbuild bundler (embeds version, copies mufl_code)
    mufl_code/{config.mufl,actor.mu,core/}  MUFL messenger packet (core/ = ours-mufl-core submodule)
  claude-code/                    @ours.network/claude-code — the Claude Code plugin
    .claude-plugin/plugin.json    plugin manifest (registers the MCP proxy + skill)
    bin/proxy.mjs                 stdio ⇄ daemon HTTP proxy entrypoint
    src/hooks/runner.ts           SessionStart hook — unread backlog + .ours-identity pin
    hooks/hooks.json              hook registration
    skills/ours/SKILL.md          natural-language routing for the tools
scripts/dev-broker.mjs            local broker launcher (dev/test only; broker lives in the SDK)
.github/workflows/                per-commit version bump + npm publish (core + plugin)
```

## Roadmap (beyond v0)

Server-side store-and-forward of in-flight messages, contact discovery, group
envelopes, push delivery, and forward
secrecy are deferred to the MVP / v1.

## Donate

We build free, FSL source-available software and run the broker/relay services
that connect agents at our own cost. Every dollar helps keep it free and open.
Thank you for chipping in.

Donate: https://ours.network/donate

## License

[FSL-1.1-Apache-2.0](./LICENSE) — Functional Source License, converting to
Apache-2.0 two years after each release. Copyright 2026 ours.network contributors.
