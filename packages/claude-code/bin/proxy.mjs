#!/usr/bin/env node
// Resolves @ours.network/mcp (the MCP server dependency) and runs its
// daemon CLI in proxy mode, forwarding the stdio MCP channel unchanged.
//
// Claude Code installs a plugin's npm dependency in one of two layouts,
// depending on its version. Either inside this plugin's own per-version
// node_modules (reachable by Node's default walk-up from this file), or in a
// SHARED `~/.claude/plugins/npm-cache/node_modules` tree that sits as a SIBLING
// of the plugin cache root — which a plain walk-up can never reach. We try the
// default resolution first, then fall back to candidate node_modules roots (any
// `npm-cache` found by walking up from this file, plus the documented
// CLAUDE_PLUGIN_DATA dir) so the proxy launches under either layout.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const require = createRequire(import.meta.url);
const SPEC = '@ours.network/mcp/dist/cli.js';
const here = dirname(fileURLToPath(import.meta.url));

// Base directories whose `node_modules` may hold the dependency when the
// default walk-up cannot reach it. Each is a directory that *contains* a
// node_modules; require.resolve({paths}) then looks under it.
function fallbackBases() {
  const bases = [];
  // Walk up from this file looking for a sibling `npm-cache` (the shared
  // plugin-dependency tree Claude Code populates on some versions).
  let dir = here;
  for (let i = 0; i < 12; i++) {
    const shared = join(dir, 'npm-cache');
    if (existsSync(join(shared, 'node_modules'))) bases.push(shared);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Documented per-plugin persistent data dir (SessionStart-installed deps).
  const dataDir = process.env.CLAUDE_PLUGIN_DATA;
  if (dataDir) bases.push(dataDir);
  return bases;
}

let cliPath;
try {
  // Per-version node_modules + ancestor walk-up.
  cliPath = require.resolve(SPEC);
} catch {
  for (const base of fallbackBases()) {
    try {
      cliPath = require.resolve(SPEC, { paths: [base] });
      break;
    } catch {
      // try the next candidate
    }
  }
}

if (!cliPath) {
  process.stderr.write(
    'ours: cannot resolve @ours.network/mcp (the MCP server dependency). ' +
      'Reinstall the ours plugin so its dependency is installed.\n',
  );
  process.exit(1);
}

// process.ppid here is the MCP client (Claude Code) that launched this shim.
// Pass it so the daemon pid-checks the CLIENT's liveness (which survives idle),
// not the connector's (which Claude tears down on idle).
// Only forward the pid when it is > 1; on macOS, orphaned processes are reparented
// to launchd (pid 1) and pidAlive(1) is always true — skip it in that case.
const env = { ...process.env };
if (!env.OURS_CLIENT_PID && process.ppid > 1) env.OURS_CLIENT_PID = String(process.ppid);
const sessionEnd = process.argv[2] === 'session-end';
const command = sessionEnd ? 'session-end' : 'proxy';
const forwarded = process.argv.slice(sessionEnd ? 3 : 2);
const child = spawn(
  process.execPath,
  [cliPath, command, ...forwarded],
  { stdio: 'inherit', env },
);

child.on('error', (err) => {
  process.stderr.write(`ours: failed to launch the proxy: ${String(err)}\n`);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
