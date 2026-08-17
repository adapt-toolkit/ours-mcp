#!/usr/bin/env node
// ours.network — `ours-uninstall`, the symmetric partner to install.mjs (v3).
//
// Same shape as the installer's bin, and for the same reason: it opens a
// terminal, builds the real effects, walks the flow and turns the result into an
// exit code. Every DECISION is in lib/uninstall.mjs (pure) and every side effect
// is in lib/effects.mjs.
//
// WHY IT HAD TO CHANGE. The v2 body removed "the ours daemon" as though there
// were only one, and it removed the ours-mcp unit — which under v3 does not
// exist, because ours-mcp is a per-session stdio proxy. A v2 uninstall run
// against a v3 install would therefore look for the wrong unit, and would know
// nothing about the SECOND daemon whose global packages it was about to remove.
// Leaving install on v3 and uninstall on v2 is the state most likely to hurt
// someone, so it does not ship that way.
//
// SAFETY: nothing here runs systemctl — the unit is removed by
// `ours daemon uninstall-service`, which refuses one it did not mark. `--purge`
// is the only irreversible step: it is never a default, never runs
// non-interactively, refuses a directory with no ours state markers at all, and
// asks for the full path to be TYPED.
import { readFileSync } from 'node:fs';
import { openTty, makeWriter, closeSync } from './lib/ui.mjs';
import { isCancel } from './lib/prompt.mjs';
import { realEffects } from './lib/effects.mjs';
import { runUninstall } from './lib/orchestrate-uninstall.mjs';

function packageVersion() {
  try {
    return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version || '?';
  } catch {
    return '?';
  }
}

const ttyFd = openTty();
const closeTty = () => { if (ttyFd != null) { try { closeSync(ttyFd); } catch { /* ignore */ } } };

let cancelling = false;
function cancel() {
  if (cancelling) return;
  cancelling = true;
  try { process.stdout.write('\n  ! Cancelled — nothing further was removed.\n'); } catch { /* ignore */ }
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
  const code = await runUninstall(process.argv.slice(2), effects);
  closeTty();
  process.exit(code);
} catch (error) {
  if (isCancel(error)) cancel();
  process.stdout.write(`ours: unexpected error: ${String(error)}\n`);
  closeTty();
  process.exit(1);
}
