# Shared gateway client configuration

Fleet, ours CLI, MCP and harness hooks select one server through
`~/.ours-client/profile.json`. `serverUrl` names the HTTP(S) gateway, with
optional base path. Daemon operations use `/daemon`; Cowork uses `/cowork`.
The profile also pins `expectedInstanceId` and an absolute `credentialPath`.
An optional `endpoint` must equal `serverUrl + "/daemon"`.

Import a prepared private profile with `ours-install client --config /absolute/profile.json`.
Use `ours config show --json` to inspect connection metadata without reading the token.
Keep the profile directory mode 0700 and files mode 0600. `OURS_CONFIG` may
select the same whole profile for all clients. Remove legacy `OURS_PORT`,
`OURS_STATE_DIR`, `OURS_API_TOKEN` and `OURS_DAEMON_ID` overrides.

Missing profiles, rejected credentials and unavailable gateways fail closed.
Clients never read daemon state, start a daemon, or try a local port/socket.
Hooks use the same gateway and return a harmless no-op on failure. Their
application-local identity/session files do not select another server.

For full-stack setup, a custom public port (such as 4050), systemd propagation
and migration, see the [gateway setup guide](https://github.com/adapt-toolkit/ours-network/blob/prerelease/packages/installer/GATEWAY_SETUP.md).
The coordinated gateway changes require approved matching package releases;
current npm nightly is not automatically evidence that these changes are installed.
Server administration uses `ours-install server` on the server host.
