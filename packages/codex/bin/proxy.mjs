#!/usr/bin/env node
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const spec = '@ours.network/mcp/dist/cli.js';
const here = dirname(fileURLToPath(import.meta.url));
let cliPath;
try { cliPath = require.resolve(spec); } catch { /* try plugin cache layouts */ }
if (!cliPath) {
  let dir = here;
  for (let i = 0; i < 12 && !cliPath; i += 1) {
    for (const base of [dir, join(dir, 'npm-cache')]) {
      if (!existsSync(join(base, 'node_modules'))) continue;
      try { cliPath = require.resolve(spec, { paths: [base] }); } catch { /* next */ }
    }
    const parent = dirname(dir); if (parent === dir) break; dir = parent;
  }
}
const env = { ...process.env };
if (env.OURS_CODEX_LIVE === '1') env.OURS_AUTOSTART = '0';
if (process.ppid > 1) env.OURS_CLIENT_PID = String(process.ppid);
const child = cliPath
  ? spawn(process.execPath, [cliPath, 'proxy', ...process.argv.slice(2)], { stdio: 'inherit', env })
  : spawn('ours-mcp', ['proxy', ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('error', (error) => { process.stderr.write(`ours: cannot launch @ours.network/mcp proxy: ${error.message}\n`); process.exit(1); });
child.on('exit', (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exit(code ?? 0); });

