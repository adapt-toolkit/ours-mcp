#!/usr/bin/env node
// Installs the ours MCP server into ~/.hermes/config.yaml — safely and idempotently.
//
// YAML is not line-oriented, so blindly appending under an existing top-level key
// (mcp_servers:) would produce a duplicate key and corrupt the file. So the planner
// only auto-writes when it is provably safe; otherwise it prints the block and asks
// the user to merge it by hand. A sentinel comment makes a second run a no-op.
//
// Reactivity needs NO config here: wake-on-mail is the agent tailing `ours-mcp watch`
// in-session (see the ours skill) — there is no webhook route, secret, or gateway.
//
// Pure functions (planConfigInstall / renderConfigBlock) are unit-tested; main()
// does the file IO. Zero dependencies.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SENTINEL = '# >>> ours.network plugin (managed block)';
const SENTINEL_END = '# <<< ours.network plugin';

// Decide how to install given the current config text. Never returns a plan that
// could corrupt existing YAML.
export function planConfigInstall(text) {
  const t = text ?? '';
  if (t.includes(SENTINEL)) return { action: 'noop', reason: 'ours block already present' };
  if (!t.trim()) return { action: 'write', reason: 'no existing config' };
  if (/^mcp_servers:/m.test(t)) {
    return {
      action: 'manual',
      reason: 'config already defines mcp_servers:; merge by hand to avoid duplicate keys',
    };
  }
  return { action: 'append', reason: 'safe to append (no conflicting top-level keys)' };
}

// Render the managed YAML block: just the ours MCP server, pointing at the globally-installed
// ours-mcp proxy. No webhook/route/secret — reactivity is in-session `ours-mcp watch`.
//
// `oursConfig` names ONE daemon's config.json, and it is the only reason this
// function takes an argument. A daemon is identified by its state directory, and
// `ours-mcp proxy` falls back to ~/.ours when nothing says otherwise — so a
// Hermes installed for a non-default state directory would silently attach to
// the DEFAULT daemon while the operator was told a different one was chosen.
// Emitting it here is what makes the endpoint and the state directory travel
// together, and Hermes is the only one of the three harnesses where that is
// possible: Claude Code's marketplace plugin is command+args with no env key,
// and Codex's env_vars is an allowlist of names rather than a value map. This
// writer is ours, so this one can be real.
//
// Omitted (the default state directory, and every install before this change) →
// the block is unchanged, byte for byte.
export function renderConfigBlock({ oursConfig = null } = {}) {
  const cfg = typeof oursConfig === 'string' ? oursConfig.trim() : '';
  const env = cfg
    ? `    env:
      OURS_CONFIG: ${JSON.stringify(cfg)}
`
    : '';
  return `${SENTINEL}
# Added by @ours.network/hermes install.sh. Remove this whole block to uninstall.
mcp_servers:
  ours:
    command: "ours-mcp"
    args: ["proxy"]
${env}    enabled: true
${SENTINEL_END}
`;
}

function main() {
  const cfgPath = process.env.HERMES_CONFIG || join(homedir(), '.hermes', 'config.yaml');
  const existing = existsSync(cfgPath) ? readFileSync(cfgPath, 'utf8') : '';
  // Taken from THIS process's environment rather than a flag: the installer
  // hands the daemon pair to the invocation it spawns, so the value is already
  // here, and a flag would be a second way to say the same thing.
  const block = renderConfigBlock({ oursConfig: process.env.OURS_CONFIG ?? null });
  const plan = planConfigInstall(existing);

  if (plan.action === 'noop') {
    console.log(`ours: config.yaml already has the ours block (${cfgPath}); nothing to do.`);
    return;
  }
  if (plan.action === 'manual') {
    console.log(
      `ours: ${cfgPath} already defines mcp_servers: and/or platforms:.\n` +
        `To avoid corrupting your config, merge the following block by hand, then run /reload-mcp:\n\n` +
        block,
    );
    process.exitCode = 3;
    return;
  }
  const next = plan.action === 'write' ? block : existing.replace(/\s*$/, '\n\n') + block;
  writeFileSync(cfgPath, next);
  console.log(`ours: ${plan.action === 'write' ? 'wrote' : 'appended ours block to'} ${cfgPath}. Run /reload-mcp in Hermes.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
