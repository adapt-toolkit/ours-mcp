#!/usr/bin/env node
// e2e for `ours-mcp define-local-identity-file`. Covers the non-interactive
// flag mode (deterministic) and the interactive survey (PACED answers — readline
// drops piped lines that arrive before the matching question() registers, so we
// wait for each prompt before replying, same as test-setup.mjs). Pure local fs:
// no broker / daemon needed. Prereq: built bundle (cd plugin && npm run build).

import { spawnSync, spawn } from 'node:child_process';
import { resolve, join } from 'node:path';
import * as fs from 'node:fs';

const CLI = resolve('packages/core/dist/cli.js');
const DIR = '/tmp/ours-define-test';
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });

let pass = 0;
const ok = (cond, m) => { if (!cond) { console.error(`\nASSERT FAILED: ${m}`); process.exit(1); } console.log(`  ✓ ${m}`); pass++; };
const run = (...args) => spawnSync('node', [CLI, 'define-local-identity-file', ...args], { encoding: 'utf8' });
const readPin = (dir) => JSON.parse(fs.readFileSync(join(dir, '.ours-identity'), 'utf8'));

console.log('=== define-local-identity-file (flags) ===\n');

// 1. all flags on
{
  const d = join(DIR, 'all'); fs.mkdirSync(d, { recursive: true });
  const r = run('--name', 'Foo', '--force-bind', '--local-book', '--auto-accept-local', '--dir', d);
  ok(r.status === 0, 'all-flags exits 0');
  const p = readPin(d);
  ok(p.identity === 'Foo' && p.force === true && p.expose_local === true && p.local_auto_accept === true, 'all-flags pin correct');
}

// 2. negations + force omitted when false
{
  const d = join(DIR, 'neg'); fs.mkdirSync(d, { recursive: true });
  const r = run('--name', 'Bar', '--no-local-book', '--no-auto-accept-local', '--dir', d);
  ok(r.status === 0, 'negations exit 0');
  const p = readPin(d);
  ok(!('force' in p) && p.expose_local === false && p.local_auto_accept === false, 'negations honored, force omitted');
}

// 3. defaults (only --name) → expose/auto true, force omitted
{
  const d = join(DIR, 'def'); fs.mkdirSync(d, { recursive: true });
  run('--name', 'Baz', '--dir', d);
  const p = readPin(d);
  ok(!('force' in p) && p.expose_local === true && p.local_auto_accept === true, 'name-only uses default exposure');
}

// 4. --print writes nothing
{
  const d = join(DIR, 'print'); fs.mkdirSync(d, { recursive: true });
  const r = run('--name', 'P', '--print', '--dir', d);
  ok(r.status === 0 && JSON.parse(r.stdout).identity === 'P', '--print emits JSON to stdout');
  ok(!fs.existsSync(join(d, '.ours-identity')), '--print writes no file');
}

// 5. clobber refusal then --overwrite
{
  const d = join(DIR, 'over'); fs.mkdirSync(d, { recursive: true });
  run('--name', 'One', '--dir', d);
  const refuse = run('--name', 'Two', '--dir', d);
  ok(refuse.status === 1 && /already exists/.test(refuse.stderr), 'refuses to clobber (exit 1)');
  ok(readPin(d).identity === 'One', 'existing file untouched after refusal');
  run('--name', 'Two', '--dir', d, '--overwrite');
  ok(readPin(d).identity === 'Two', '--overwrite replaces the file');
}

// 6. missing name in non-interactive mode
{
  const r = run('--force-bind');
  ok(r.status === 1 && /--name is required/.test(r.stderr), 'missing --name errors');
}

console.log('\n=== define-local-identity-file (interactive survey) ===\n');

const answers = [
  [/Identity name:/, 'Carol'],
  [/Force-bind/, 'y'],
  [/Add to the host-local contact book\?/, 'n'],
  [/Auto-accept local invites/, 'n'],
];

const surveyDir = join(DIR, 'survey'); fs.mkdirSync(surveyDir, { recursive: true });
let idx = 0, buf = '';
const child = spawn('node', [CLI, 'define-local-identity-file'], { cwd: surveyDir, stdio: ['pipe', 'pipe', 'inherit'] });
child.stdout.on('data', (d) => {
  buf += d.toString();
  if (idx < answers.length && answers[idx][0].test(buf)) {
    child.stdin.write(answers[idx][1] + '\n');
    buf = '';
    idx++;
    if (idx === answers.length) child.stdin.end();
  }
});
child.on('exit', (code) => {
  ok(code === 0, `survey exits 0 (got ${code})`);
  const p = readPin(surveyDir);
  ok(p.identity === 'Carol', 'survey name captured');
  ok(p.force === true, 'survey force=y → true');
  ok(p.expose_local === false, 'survey local-book=n → expose_local false');
  ok(p.local_auto_accept === false, 'survey auto=n → local_auto_accept false');
  console.log(`\n=== DEFINE-IDENTITY TEST PASSED (${pass} assertions) ===`);
  fs.rmSync(DIR, { recursive: true, force: true });
});
