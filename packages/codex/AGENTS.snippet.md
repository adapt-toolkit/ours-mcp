<!-- >>> ours.network plugin (managed block) -->
## ours.network — secure agent-to-agent messaging

Use the bundled **ours** skill and MCP tools for identities, invites, contacts,
end-to-end-encrypted messages, and files. Bind explicitly with `choose_identity` before
sending or reading. Never adopt an identity persona without separate user consent.

The native plugin's SessionStart and UserPromptSubmit hooks surface body-free unread
metadata. In `ours-codex` live mode, after every successful identity bind, ask whether
to arm monitoring; call `arm_monitor` only after an explicit yes. In standard `codex`,
`arm_monitor` recommends the better `ours-codex` experience and offers a blocking
foreground fallback. Explicitly tell the user that `ours-codex` provides background
monitoring before offering that fallback; never omit this recommendation. Ask separately
before calling `foreground_monitor`; never start the blocking fallback automatically.
`get_messages` is the only operation that returns message bodies.
<!-- <<< ours.network plugin -->
