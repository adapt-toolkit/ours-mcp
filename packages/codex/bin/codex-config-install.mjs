#!/usr/bin/env node
// Installs the ours MCP server into ~/.codex/config.toml — safely and idempotently.
//
// Codex config is TOML, which (unlike Hermes's YAML) is line-oriented enough that
// APPENDING a fresh `[mcp_servers.ours]` table at EOF is safe — provided that table
// is not already defined. So the planner is simpler than Hermes's: append when the
// server isn't there yet, noop when our sentinel or a `[mcp_servers.ours]` table is
// already present. A sentinel comment makes a second run a no-op.
//
// Pure functions (planTomlInstall / renderTomlBlock) are unit-tested; main() does the
// file IO. Zero dependencies.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SENTINEL = '# >>> ours.network plugin (managed block)';
const SENTINEL_END = '# <<< ours.network plugin';

// Decide how to install given the current config.toml text. Never returns a plan
// that would define `[mcp_servers.ours]` twice (which Codex would reject or where
// the later table would silently win).
export function planTomlInstall(text) {
  const t = text ?? '';
  if (t.includes(SENTINEL)) return { action: 'noop', reason: 'ours block already present' };
  // A bare `[mcp_servers.ours]` table (installed by hand or `codex mcp add ours`)
  // counts as installed — appending ours would duplicate the table.
  if (/^\s*\[mcp_servers\.ours\]/m.test(t)) {
    return { action: 'noop', reason: '[mcp_servers.ours] already defined' };
  }
  if (!t.trim()) return { action: 'write', reason: 'no existing config' };
  return { action: 'append', reason: 'safe to append a new [mcp_servers.ours] table at EOF' };
}

// Render the managed TOML block: the `ours` MCP server pointing at the globally-installed
// daemon proxy (`ours-mcp proxy`). Equivalent to `codex mcp add ours -- ours-mcp proxy`.
export function renderTomlBlock() {
  return `${SENTINEL}
# Added by @ours.network/codex install.sh. Remove this whole block to uninstall.
# Equivalent CLI: codex mcp add ours -- ours-mcp proxy
[mcp_servers.ours]
command = "ours-mcp"
args = ["proxy"]
# Optional per-server environment overrides go here, e.g.:
# [mcp_servers.ours.env]
# OURS_PORT = "3050"
${SENTINEL_END}
`;
}

function main() {
  const cfgPath = process.env.CODEX_CONFIG || join(homedir(), '.codex', 'config.toml');
  const existing = existsSync(cfgPath) ? readFileSync(cfgPath, 'utf8') : '';
  const block = renderTomlBlock();
  const plan = planTomlInstall(existing);

  if (plan.action === 'noop') {
    console.log(`ours: config.toml already has the ours MCP server (${cfgPath}); nothing to do.`);
    return;
  }
  const next = plan.action === 'write' ? block : existing.replace(/\s*$/, '\n\n') + block;
  writeFileSync(cfgPath, next);
  console.log(
    `ours: ${plan.action === 'write' ? 'wrote' : 'appended [mcp_servers.ours] to'} ${cfgPath}. ` +
      `The ours MCP server is live for the next Codex session.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
