// Non-blocking version-skew notice. The daemon is a shared singleton that can
// outlive an upgrade; we never refuse and never auto-restart — just announce.
export function formatVersionAdvisory(args: { selfVersion: string; daemonVersion: string | null }): string | null {
  const { selfVersion, daemonVersion } = args;
  if (!daemonVersion || daemonVersion === selfVersion) return null;
  return (
    `ours: version mismatch — this plugin/connector is v${selfVersion}, the running daemon is ` +
    `v${daemonVersion}. Everything still works; for the best experience run matching versions. The ` +
    `daemon is a shared singleton and is never restarted automatically, so when no other session is ` +
    `mid-task run \`ours-mcp stop\` (the next session starts the daemon at the new version) — or ` +
    `update the lagging side to match. No action is required; this is advisory.`
  );
}
