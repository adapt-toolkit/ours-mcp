#!/usr/bin/env node
// setup CLI e2e: drives `ours-mcp setup` with PACED answers — waits for each
// prompt before replying, because readline drops piped lines that arrive before
// the matching question() is registered. Runs against an ISOLATED config + state
// dir (no daemon there, so setup makes no restart attempt) and asserts the file.

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import * as fs from 'node:fs';

const CLI = resolve('packages/core/dist/cli.js');
const DIR = '/tmp/ours-setup-test';
const CFG = resolve(DIR, 'config.json');
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(resolve(DIR, 'state'), { recursive: true });

const answers = [
  [/broker URL \[/, 'ws://setup-test:9/b'],
  [/HTTP port \[/, '7070'],
  [/state dir \[/, '/tmp/setup-entered-state'],
  [/GC interval \(ms\) \[/, '4242'],
];
let idx = 0;

const env = { ...process.env, OURS_CONFIG: CFG, OURS_STATE_DIR: resolve(DIR, 'state') };
delete env.OURS_BROKER_URL;
delete env.OURS_PORT;
delete env.OURS_GC_INTERVAL_MS;

const child = spawn('node', [CLI, 'setup'], { env, stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
child.stdout.on('data', (d) => {
  process.stdout.write(d);
  buf += d.toString();
  if (idx < answers.length && answers[idx][0].test(buf)) {
    child.stdin.write(answers[idx][1] + '\n');
    buf = '';
    idx++;
  }
});

child.on('exit', (code) => {
  const ok = (cond, m) => {
    if (!cond) { console.error(`\nASSERT FAILED: ${m}`); process.exit(1); }
    console.log(`  ✓ ${m}`);
  };
  try {
    const c = JSON.parse(fs.readFileSync(CFG, 'utf8'));
    const mode = fs.statSync(CFG).mode & 0o777;
    console.log('');
    ok(code === 0, `setup exited 0 (got ${code})`);
    ok(c.brokerUrl === 'ws://setup-test:9/b', 'brokerUrl written from prompt');
    ok(c.port === 7070, 'port written from prompt');
    ok(c.stateDir === '/tmp/setup-entered-state', 'stateDir written from prompt');
    ok(c.gcIntervalMs === 4242, 'gcIntervalMs written from prompt');
    ok(mode === 0o600, `config.json mode 0600 (got ${mode.toString(8)})`);
    console.log('\n=== SETUP TEST PASSED ===');
  } catch (e) {
    console.error('\nSETUP TEST FAILED:', e.message);
    process.exit(1);
  }
});
