// Shared UI toolkit for the ours.network Node installer + uninstaller: colors that degrade
// gracefully, the ASCII banner, and /dev/tty-aware prompts (so `curl | bash` still works and
// true-headless runs fall back to env vars). No dependencies — pure Node, ESM.
import { openSync, closeSync, writeSync } from 'node:fs';

// --- colors -----------------------------------------------------------------------------------
// Enabled only for a real terminal and when NO_COLOR is unset (https://no-color.org). Everything
// routes through c()/style helpers so a no-color run is plain ASCII, never raw escape codes.
const COLOR = !process.env.NO_COLOR && (process.env.OURS_FORCE_COLOR === '1' || process.stdout.isTTY);
const E = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m',
  red: '\x1b[31m', blue: '\x1b[34m', magenta: '\x1b[35m', gray: '\x1b[90m',
};
function wrap(code, s) { return COLOR ? code + s + E.reset : String(s); }
export const c = {
  bold: (s) => wrap(E.bold, s), dim: (s) => wrap(E.dim, s), gray: (s) => wrap(E.gray, s),
  cyan: (s) => wrap(E.cyan, s), green: (s) => wrap(E.green, s), yellow: (s) => wrap(E.yellow, s),
  red: (s) => wrap(E.red, s), blue: (s) => wrap(E.blue, s), magenta: (s) => wrap(E.magenta, s),
};

// --- banner -----------------------------------------------------------------------------------
// The colored "ours.network" wordmark + a mesh accent + the website tagline. No ASCII-art
// block letters (they read crooked at terminal widths). Kept under 80 columns so it never wraps
// on a default terminal. Colour is applied per-line; plain ASCII with NO_COLOR.
export function banner() {
  const dot = c.gray('·');
  const mesh = `${c.cyan('◇')}${dot}${c.cyan('◇')}${dot}${c.cyan('◇')}`;
  const out = [];
  out.push('');
  out.push('  ' + c.bold(c.cyan('ours')) + c.gray('.network') + '   ' + mesh);
  out.push('  ' + c.dim('The space where humans and AI agents collaborate'));
  out.push('');
  return out.join('\n');
}

// --- section + status helpers -----------------------------------------------------------------
export function section(n, title) {
  return '\n' + c.bold(c.cyan(`${n})`)) + ' ' + c.bold(title);
}
export function heading(title) { return '\n' + c.bold(c.cyan(title)); }
export const ok = (s) => `  ${c.green('✓')} ${s}`;
export const step = (s) => `  ${c.dim('…')} ${s}`;
export const info = (s) => `  ${c.gray('•')} ${s}`;
export const warn = (s) => `  ${c.yellow('!')} ${s}`;
export const why = (s) => `    ${c.gray('why: ' + s)}`;

// --- framed panel -------------------------------------------------------------------------------
// A boxed block for the one moment that must stand out (the post-first-install next steps).
// Content lines must be PLAIN strings (no ANSI) so the width math stays honest — only the frame
// is coloured, which degrades to plain box-drawing under NO_COLOR.
export function box(lines, title = '') {
  const inner = Math.max(...lines.map((l) => l.length), title.length + 2) + 2;
  const bar = (s) => c.cyan(s);
  const top = title
    ? bar('┌─') + ' ' + c.bold(title) + ' ' + bar('─'.repeat(inner - title.length - 3) + '┐')
    : bar('┌' + '─'.repeat(inner) + '┐');
  const row = (l) => bar('│') + ' ' + l + ' '.repeat(inner - l.length - 1) + bar('│');
  const bottom = bar('└' + '─'.repeat(inner) + '┘');
  return [top, ...lines.map(row), bottom].map((l) => '  ' + l).join('\n');
}

// --- /dev/tty-aware prompting ------------------------------------------------------------------
// Probe by OPENING /dev/tty read-write: the device node is world-rw, so a permission check passes
// even with no controlling terminal (headless/CI). open() fails (ENXIO) when there is genuinely no
// terminal — only then do we truly have no tty. Mirrors install.sh's bash probe exactly.
export function openTty() {
  try {
    const fd = openSync('/dev/tty', 'r+');
    return fd;
  } catch {
    return null;
  }
}

// Write to the tty (falls back to stdout if no tty fd). Used for prompts drawn on the controlling
// terminal so they survive `curl | bash` (where stdout may be the far end of a pipe). We use a
// blocking fs.writeSync — NOT a tty.WriteStream — because wrapping the fd in a tty stream flips it
// to non-blocking, which would make our fs.readSync-based prompt reads throw EAGAIN.
export function makeWriter(ttyFd) {
  if (ttyFd == null) return (s) => process.stdout.write(s);
  return (s) => { try { writeSync(ttyFd, s); } catch { /* ignore */ } };
}

export { closeSync };
