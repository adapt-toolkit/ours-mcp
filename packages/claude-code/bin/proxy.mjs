#!/usr/bin/env node
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { containerInvocation } from './container-launch.mjs';
import { runContainerProxy } from './container-file-transfer.mjs';

const sessionEnd = process.argv[2] === 'session-end';
const watch = process.argv[2] === 'watch';
const command = sessionEnd ? 'session-end' : 'proxy';
const forwarded = process.argv.slice(sessionEnd ? 3 : 2);
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
  const network = await import('../dist/network-client.mjs');
  const profile = network.hostProfileFromEnv(env);
  if (profile) {
    const configPath = env.OURS_MCP_CONFIG || join(env.HOME || homedir(), '.ours-mcp', 'config.json');
    const hostRecordRoot = dirname(configPath);
    if (sessionEnd) {
      const payload = JSON.parse(readFileSync(0, 'utf8') || '{}');
      if (typeof payload.session_id !== 'string' || !payload.session_id) throw new Error('SessionEnd requires session_id.');
      await network.endNetworkNativeSession({ profile, nativeSessionId: payload.session_id, hostRecordRoot });
      return;
    }
    const nativeSessionId = env.CLAUDE_CODE_SESSION_ID;
    if (watch) {
      await network.runNetworkWatch({ identity: process.argv[3], nativeSessionId, profile, hostRecordRoot, env });
      return;
    }
    await network.runNetworkProxy({ nativeSessionId, profile, hostRecordRoot, env });
    return;
  }

  const container = containerInvocation(watch ? 'watch' : command, watch ? process.argv.slice(3) : forwarded, env);
  if (container) {
    const child = watch || sessionEnd
      ? spawn(container.command, container.args, { stdio: watch ? ['pipe', 'inherit', 'inherit'] : 'inherit', env: container.env })
      : runContainerProxy(container);
    if (watch) {
      const stop = () => { child.stdin?.end(); if (!child.killed) child.kill('SIGTERM'); };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    }
    if (watch || sessionEnd) relayChild(child, 'container MCP');
    return;
  }

  const cliPath = resolveLocalServer();
  if (!cliPath) {
    throw new Error('cannot resolve @ours.network/mcp. Install the main MCP server explicitly or select an ours host network profile.');
  }
  if (!env.OURS_CLIENT_PID && process.ppid > 1) env.OURS_CLIENT_PID = String(process.ppid);
  const child = spawn(process.execPath, [cliPath, command, ...forwarded], { stdio: 'inherit', env });
  relayChild(child, 'the proxy');
}

main().catch((error) => {
  process.stderr.write(`ours: ${error.message}\n`);
  process.exitCode = 1;
});
