# ours for Cursor

This repository does not ship a native Cursor plugin. Cursor users can register
the agent-agnostic MCP adapter manually with command `ours-mcp` and argument
`proxy`; all messaging and file tools then use the same shared-daemon connection.
No one-click installer or generated Cursor rules are currently provided.
