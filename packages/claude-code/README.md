# OURS Claude Code plugin

The plugin connects Claude's existing native session to the selected OURS server.
Its host bridge and hooks remain part of the Claude integration; the main MCP
server runs with the server installation.

New plugin invocations select explicit `OURS_CONFIG` first, otherwise the private
`~/.ours-client/profile.json` when present. With the managed profile, ordinary
`claude` launches need no environment override. The file contains the existing
`endpoint`, `expectedInstanceId` and absolute `credentialPath` tuple. Invalid or
unreadable managed profiles fail without selecting Docker or a local MCP server.
When neither selection exists, existing unmanaged behavior remains available.

An explicit override applies to a new invocation. It does not rebind existing
sessions or change `OURS_MCP_CONFIG`, application state or native ownership.
The existing SessionEnd hook remains responsible for native session completion.
