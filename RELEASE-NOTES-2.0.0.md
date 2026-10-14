# MCP suite 2.0.0 (major release candidate)

This release promotes the validated `prerelease` line to `main` as a major
release. Versions are produced by the `main` version-bump job, not written by
hand.

| package | current `latest` | expected release |
|---|---|---|
| `@ours.network/mcp` | 1.1.1 | 2.0.0 |
| `@ours.network/claude-code` (+ `.claude-plugin/plugin.json`) | 1.1.1 | 2.0.0 |
| `@ours.network/codex` (+ `.codex-plugin/plugin.json`) | 1.1.1 | 2.0.0 |
| `@ours.network/hermes` | 1.1.1 | 2.0.0 |

## Breaking changes

- Requires the SDK 4 line: default client attach goes through a saved shared
  gateway client profile, legacy environment daemon selection is rejected, and
  the daemon runtime ships separately as `@ours.network/daemon`. See ours-sdk
  `RELEASE-NOTES-4.0.0.md`.
- MCP no longer owns or publishes `@ours.network/install`; installer ownership
  moved to ours-network (#106). The installer's last MCP-published `latest` is 1.1.1.
- Harness MCP tools run locally through the daemon API (#110), and clients share
  gateway selection across MCP and harness clients (#117).

## Stable dependency pins (blocked on upstream publication)

`prerelease` pins nightly `@ours.network/*` versions exactly. Before this
release merges, the release branch must be repinned to the published stable
versions below, `package-lock.json` regenerated, and CI rerun on the new head:

| manifest | dependency | prerelease pin | stable target |
|---|---|---|---|
| `packages/core` (`@ours.network/mcp`) | `@ours.network/sdk` | 3.8.1-nightly.18 | 4.0.0 |
| `packages/core` (dev) | `@ours.network/cli` / `@ours.network/daemon` | 2.8.1-nightly.16 / 3.8.1-nightly.10 | 3.0.0 / 4.0.0 |
| `packages/claude-code`, `packages/codex` | `@ours.network/sdk` | 3.8.1-nightly.18 | 4.0.0 |
| root workspace (dev) | `@ours.network/sdk` | 3.8.1-nightly.18 | 4.0.0 |

`@ours.network/mcp` pins inside `claude-code`/`codex` (1.1.1 today) are rewritten to the suite version (2.0.0) by the lockstep bump itself.

None of these stable versions is published at the time of writing; they are the
versions the upstream `main` bump jobs are expected to produce.

## Features

- expose compatible managed MCP for Fleet supervisors (#111)
- support verified HTTPS connections to remote servers (#107)
- optional Docker installation and external daemon integrations (#103)
- advertise the managed chat export directory to agents
- route opted-in managed `send_file` calls without contact to the current chat

## Fixes

- share gateway selection across MCP and harness clients (#117)
- accept prefixed daemon endpoints in native MCP profiles (#112)

## Merging

The `main` bump reads only the head commit message. Merge with a merge commit
whose subject is `feat!: promote prerelease to main` and whose body contains a
`BREAKING CHANGE:` line; the default "Merge pull request" subject yields a patch.
