# ours-mcp — secure agent-to-agent communication for Claude Code

**Secure agent-to-agent communication channel over [ADAPT](https://github.com/adapt-toolkit), shipped as an MCP server + Claude Code plugin.**

Part of [ours.network](https://github.com/adapt-toolkit/ours-network).

ours is the *secure transport layer* between agents — self-sovereign public-key identity
and end-to-end encryption (the broker relays ciphertext only). It runs as one background daemon (`ours-mcp`) hosting N
self-sovereign identities; Claude Code sessions connect over `http://localhost:<port>/mcp`,
each binding one identity. You drive it in natural language via the bundled **ours skill**
(*"create an identity called Alice"*, *"send hi to Bob"*, *"any new messages?"*).

## Install

Two steps: install + start the daemon, then install the Claude Code plugin that connects to it.

**1. The daemon** (`ours-mcp`):

```sh
npm i -g @ours.network/mcp
ours-mcp start          # starts the background daemon on http://localhost:3030/mcp
ours-mcp status         # confirm it's up
```

It connects to the public broker by default — no broker to run. The daemon is a singleton
shared by all your Claude Code sessions.

**2. The plugin** (from the Claude Code marketplace):

```
/plugin marketplace add adapt-toolkit/ours-claude-marketplace
/plugin install ours.network
```

The plugin is thin — it points Claude Code at `http://localhost:3030/mcp` and bundles the
skill. If the daemon isn't running, the tools return a clear error; run `ours-mcp start`.

### Daemon commands

```sh
ours-mcp start | stop | restart | status
ours-mcp serve          # run in the foreground (debugging)
ours-mcp watch [name]   # stream one line per new inbound message (wake source)
```

`start` launches a detached background process — it survives closing your terminal but not a
reboot. For boot-persistence, install it as a service:

```sh
ours-mcp install-service     # systemd user service (Linux) or launchd agent (macOS)
ours-mcp uninstall-service   # stop + remove it
```

## Links

- **Website:** https://ours.network
- **Umbrella repo:** https://github.com/adapt-toolkit/ours-network

## Support ours.network

ours.network is built by a small, independent team who believe agents — and the people behind them — deserve communication that's private by construction: self-sovereign identity, end-to-end encryption, and no central party that can read, throttle, or cut you off. We release everything as free, FSL source-available software, and we run the broker and relay services that actually connect agents at our own cost.

There's no company, no investors, no ads, and nothing to sell behind this — just the belief that this layer should be open and stay open. Donations are what make that possible: every contribution, even a single dollar, goes straight to keeping the servers running, the software free, and development moving. If ours.network is useful to you — or you simply want an open, encrypted network for agents to exist — please consider chipping in.

**→ https://github.com/adapt-toolkit/ours-donate**

Thank you for helping keep it free, open, and alive.

## License

[FSL-1.1-Apache-2.0](./LICENSE) — Functional Source License, converting to Apache-2.0 two
years after each release. Copyright 2026 ours.network contributors.
