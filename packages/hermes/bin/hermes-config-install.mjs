#!/usr/bin/env node
// Installs the ours blocks into ~/.hermes/config.yaml — safely and idempotently.
//
// YAML is not line-oriented, so blindly appending under an existing top-level key
// (mcp_servers:/platforms:) would produce a duplicate key and corrupt the file.
// So the planner only auto-writes when it is provably safe; otherwise it prints
// the block and asks the user to merge it by hand. A sentinel comment makes a
// second run a no-op.
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
  if (/^mcp_servers:/m.test(t) || /^platforms:/m.test(t)) {
    return {
      action: 'manual',
      reason: 'config already defines mcp_servers: and/or platforms:; merge by hand to avoid duplicate keys',
    };
  }
  return { action: 'append', reason: 'safe to append (no conflicting top-level keys)' };
}

// Render the managed YAML block: the MCP server (points at the globally-installed
// ours-mcp proxy) + the webhook route the connector pokes to wake a drain.
export function renderConfigBlock({ secret, webhookPort = 8644, identities = [] } = {}) {
  const idNote = identities.length
    ? `  #   watched identities: ${identities.join(', ')}`
    : '  #   watched identities: (set CONNECTOR_IDENTITIES when starting the watcher)';
  return `${SENTINEL}
# Added by @ours.network/hermes install.sh. Remove this whole block to uninstall.
mcp_servers:
  ours:
    command: "ours-mcp"
    args: ["proxy"]
    enabled: true
platforms:
  webhook:
    enabled: true
    extra:
      port: ${webhookPort}
      routes:
        ours-wake:
          events: ["ours_wake"]
          secret: "${secret}"
          skills: ["ours"]
          deliver: "log"
          prompt: |
            New ours.network mail arrived for identity "{identity}". Use the ours skill:
            bind that identity if it is not already bound, then call the ours get_messages
            tool to read the message(s) and act on them. Reply over ours if a reply is expected.
${idNote}
${SENTINEL_END}
`;
}

function main() {
  const secret = process.env.OURS_WAKE_SECRET;
  if (!secret || secret === 'CHANGE_ME_local_webhook_hmac') {
    console.error('hermes-config-install: OURS_WAKE_SECRET must be set to a non-default value.');
    process.exit(2);
  }
  const identities = (process.env.CONNECTOR_IDENTITIES || '').split(/\s+/).filter(Boolean);
  const webhookPort = Number(process.env.OURS_WEBHOOK_PORT || 8644);
  const cfgPath = process.env.HERMES_CONFIG || join(homedir(), '.hermes', 'config.yaml');
  const existing = existsSync(cfgPath) ? readFileSync(cfgPath, 'utf8') : '';
  const block = renderConfigBlock({ secret, webhookPort, identities });
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
