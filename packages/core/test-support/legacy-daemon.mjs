#!/usr/bin/env node
// Retained published runtime fixture only. Production MCP has no CLI dependency.
// Set OURS_DAEMON_CLI to the new daemon artifact for source-split qualification.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
const require = createRequire(import.meta.url);
const cli = join(dirname(require.resolve('@ours.network/cli/package.json')), 'dist/cli.js');
const child = spawn(process.execPath, [cli, 'daemon', ...process.argv.slice(2)], { stdio: 'inherit' });
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => child.kill(signal));
child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
