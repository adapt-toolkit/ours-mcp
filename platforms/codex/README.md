# ours for Codex — planned

**Status: planned, not yet implemented.** This directory is a placeholder so the
repo structure signals where the OpenAI Codex integration will live.

Intended approach (no code here yet): register the agent-agnostic server as an
MCP server — `codex mcp add ours -- npx -y @ours.network/mcp proxy`
(or the equivalent `~/.codex/config.toml` `[mcp_servers.ours]` block) — and
ship the ours usage guidance as an `AGENTS.md`. Codex has no plugin
marketplace, so distribution is a documented one-liner plus the instructions
file, both generated from the single canonical skill doc.

The file tools (`send_file`, `list_incoming_files`, `get_files`, `list_files`,
`get_file_info`, `save_file`) need no extra
registration — they ride the same proxy→daemon seam as every other tool, so they
appear automatically once the server above is registered.
