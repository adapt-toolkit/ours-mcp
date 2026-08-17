#!/usr/bin/env node
// ours.network — `ours-install`, the unified stack installer (v3).
//
// THIS FILE IS A BIN, AND THAT IS ALL IT IS. It opens a terminal, builds the
// real effects, walks the flow, and turns the result into an exit code. Every
// decision lives in lib/ (pure, separately tested) and every side effect lives
// in lib/effects.mjs (one small auditable module) — so "what can this installer
// do to my machine" is one file to read, and "what will it decide" is another.
//
// The v2 body that used to live here is gone: it assumed @ours.network/mcp WAS
// the daemon and got the systemd unit. Under v3 the daemon is the ours-sdk CLI,
// identified by its STATE DIRECTORY rather than its port, and ours-mcp is a
// per-session stdio proxy with no unit at all. Keeping both flows in one file
// would have meant two answers to "which thing is the daemon".
//
// SAFETY: nothing here runs systemctl. systemd is reached only through
// `ours daemon install-service`, which owns the marker check and the enable.
// `--dry-run` is the same walk with every mutation replaced by a printed line.
import { readFileSync } from 'node:fs';
import { openTty, makeWriter, closeSync } from './lib/ui.mjs';
import { isCancel } from './lib/prompt.mjs';
import { realEffects } from './lib/effects.mjs';
import { runInstall } from './lib/orchestrate.mjs';

function packageVersion() {
  try {
    return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version || '?';
  } catch {
    return '?';
  }
}

const ttyFd = openTty();
const closeTty = () => { if (ttyFd != null) { try { closeSync(ttyFd); } catch { /* ignore */ } } };

// Ctrl+C at ANY prompt aborts cleanly — one line, exit 130, never the old
// "^C^C^C and keeps going". The handler covers a ^C while idle; the
// InstallCancelled thrown out of a blocked prompt read covers a ^C mid-prompt.
let cancelling = false;
function cancel() {
  if (cancelling) return;
  cancelling = true;
  try { process.stdout.write('\n  ! Installation cancelled — re-run any time.\n'); } catch { /* ignore */ }
  closeTty();
  process.exit(130);
}
if (ttyFd != null && !process.env.OURS_ASSUME_YES) process.on('SIGINT', cancel);

try {
  const effects = realEffects({
    write: makeWriter(ttyFd),
    ttyFd,
    env: process.env,
    version: packageVersion(),
  });
  const code = await runInstall(process.argv.slice(2), effects);
  closeTty();
  // Exit explicitly right after the summary: a lingering clipboard child or a
  // signal listener must never leave the user at a hung installer.
  process.exit(code);
} catch (error) {
  if (isCancel(error)) cancel();
  process.stdout.write(`ours: unexpected error: ${String(error)}\n`);
  closeTty();
  process.exit(1);
}
