# ours for Cursor — planned

**Status: planned, not yet implemented.** This directory is a placeholder so the
repo structure signals where the Cursor integration will live.

Intended approach (no code here yet): register the agent-agnostic server as an
MCP server via an `mcp.json` snippet (`{ "command": "npx", "args": ["-y",
"@ours.network/mcp", "proxy"] }`) plus a one-click install deeplink
(`cursor://anysphere.cursor-deeplink/mcp/install?name=ours&config=<base64>`),
and ship the ours usage guidance as `.cursor/rules`. Both the deeplink and the
rules are generated from the single canonical skill doc.

The file tools (`send_file`, `list_incoming_files`, `get_files`, `list_files`,
`get_file_info`, `save_file`) need no extra
registration — they ride the same proxy→daemon seam as every other tool, so they
appear automatically once the server above is registered.
