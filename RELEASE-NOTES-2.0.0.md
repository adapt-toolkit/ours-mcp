# MCP suite 2.0.0 (major release)

This release promotes the validated `prerelease` line to `main` as a major
lockstep release of the MCP suite. Versions are produced by the `main`
version-bump job from the merge commit's Conventional Commits subject; they are
not written by hand.

| package | current `latest` | expected release |
|---|---|---|
| `@ours.network/mcp` | 1.1.1 | 2.0.0 |
| `@ours.network/claude-code` | 1.1.1 | 2.0.0 (pins `@ours.network/mcp` 2.0.0) |
| `@ours.network/codex` | 1.1.1 | 2.0.0 (pins `@ours.network/mcp` 2.0.0) |
| `@ours.network/hermes` | 1.1.1 | 2.0.0 |

`@ours.network/install` is no longer published from this repository; the
installer is owned and published by `ours-network`.

## Dependencies

- `@ours.network/sdk` 5.0.0 (exact pin; previously a 4.1.1 nightly)
- development: `@ours.network/cli` 4.0.0 and `@ours.network/daemon` 5.0.0

## Breaking changes

- The installer package and its publication moved to `ours-network` (#106).
- Harness MCP tools run locally through the daemon API (#110); the Claude Code
  and Codex plugins depend on the exact suite `@ours.network/mcp` version.
- Connections use a shared gateway selection across MCP and harness clients
  and support verified HTTPS connections to remote servers (#107, #117).

## Features and fixes promoted from prerelease

- Optional Docker installation and external daemon integrations (#103).
- Compatible managed MCP exposed for Fleet supervisors (#111); prefixed daemon
  endpoints accepted in native MCP profiles (#112).
- Managed chat export directory advertised to agents; opted-in managed
  `send_file` calls without a contact route to the current chat.

## Release pipeline

The stable publish job's Codex metadata check now asserts that the Claude Code
and Codex plugins pin the exact suite `@ours.network/mcp` version, matching what
the version bump writes and what the prerelease pipeline already publishes.
