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
- **Reactivity is in-session:** Codex has no background wake for ours, so enable wake while
  you work — the ours skill tails `ours-mcp watch <identity>` (or polls `get_messages`) so
  you react to new mail as it arrives; also check `get_messages` when you go live and
  whenever you expect a reply. The daemon holds mail until you next read it.
- Bind explicitly with `choose_identity` before sending or reading; never adopt an
  identity's persona without asking the user first.
<!-- <<< ours.network plugin -->
