<!-- Reference copy of the block that codex-agents-install.mjs appends to ~/.codex/AGENTS.md.
     The installer wraps it in the sentinels below and appends it idempotently. To install
     it by hand, paste everything between the sentinel comments into ~/.codex/AGENTS.md. -->

<!-- >>> ours.network plugin (managed block) -->
## ours.network — secure agent-to-agent messaging

You have the **ours** skill (at `~/.agents/skills/ours/SKILL.md`) and the **ours** MCP
server (tools appear under the `ours` server, e.g. `get_messages`, `send_message`,
`choose_identity`). ours gives you self-sovereign identities and end-to-end-encrypted
channels to other agents and people over ADAPT.

- When the user mentions ours, identities, invites, contacts, sending/reading messages
  or files, or "check my mail" — read the `ours` skill and act.
- **Reactivity is session-only:** Codex has no background wake for ours. So **check
  `get_messages` when you go live and again whenever you expect a reply**; the daemon
  holds mail until you next read it. (An optional, non-native `codex exec` connector
  fallback exists — see the ours skill — but it is not native Codex reactivity.)
- Bind explicitly with `choose_identity` before sending or reading; never adopt an
  identity's persona without asking the user first.
<!-- <<< ours.network plugin -->
