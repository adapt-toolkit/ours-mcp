#!/usr/bin/env node
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';


const sessionEnd = process.argv[2] === 'session-end';
const watch = process.argv[2] === 'watch';
const command = sessionEnd ? 'session-end' : watch ? 'watch' : 'proxy';
const forwarded = process.argv.slice(sessionEnd || watch ? 3 : 2);
const env = { ...process.env };
const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

function resolveLocalServer() {
  const spec = '@ours.network/mcp/dist/cli.js';
  try { return require.resolve(spec); } catch { /* try plugin cache layouts */ }
  const bases = [];
  let dir = here;
  for (let index = 0; index < 12; index += 1) {
    const shared = join(dir, 'npm-cache');
    if (existsSync(join(shared, 'node_modules'))) bases.push(shared);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (env.CLAUDE_PLUGIN_DATA) bases.push(env.CLAUDE_PLUGIN_DATA);
  for (const base of bases) {
    try { return require.resolve(spec, { paths: [base] }); } catch { /* next */ }
  }
  return null;
}

function relayChild(child, label) {
  child.on('error', (error) => {
    process.stderr.write(`ours: cannot launch ${label}: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 0;
  });
}

async function main() {
  const cliPath = resolveLocalServer();
  if (!cliPath) {
    throw new Error('cannot resolve @ours.network/mcp. Reinstall the plugin with its declared MCP dependency.');
  }
  if (!env.OURS_CLIENT_PID && process.ppid > 1) env.OURS_CLIENT_PID = String(process.ppid);
  const child = spawn(process.execPath, [cliPath, command, ...forwarded], { stdio: 'inherit', env });
  relayChild(child, 'the proxy');
}

main().catch((error) => {
  process.stderr.write(`ours: ${error.message}\n`);
  process.exitCode = 1;
});
