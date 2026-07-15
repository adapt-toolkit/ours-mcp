// Pure, dependency-free logic for the ours.network installer — everything here is a plain
// function with no I/O so it can be unit-tested directly (no subprocess, no tty). The install.mjs
// orchestrator wires these to real npm/ours-mcp/tty calls; the integration tests drive that via
// install.sh. Keeping the decisions here means the tricky bits (harness canon, port-conflict,
// config merge, version parsing) are covered by fast, hermetic tests.

// canonHarnesses: normalize a free-form selection (numbers, names, or "all") into canonical
// harness names, de-duped, order-preserving. Faithful port of install.sh's canon_harnesses.
// Returns { names: string[], unknown: string[] } — unknown tokens are reported, not fatal.
export function canonHarnesses(raw) {
  const names = [];
  const unknown = [];
  const push = (n) => { if (!names.includes(n)) names.push(n); };
  const toks = String(raw || '').toLowerCase().replace(/,/g, ' ').split(/\s+/).filter(Boolean);
  for (const tok of toks) {
    switch (tok) {
      case 'all': case 'a':
        return { names: ['claude-code', 'codex', 'hermes'], unknown };
      case '1': case 'claude-code': case 'claude': case 'cc': push('claude-code'); break;
      case '2': case 'codex': push('codex'); break;
      case '3': case 'hermes': push('hermes'); break;
      case 'none': case 'skip': case '0': break;
      default: unknown.push(tok);
    }
  }
  return { names, unknown };
}

// The Telegram connector owns 3051 — the installer must never hand a daemon that port.
export const RESERVED_PORTS = [3051];
export const DEFAULT_PORT = 3050;
export const DEFAULT_BROKER = 'wss://broker1.ours.network';

// suggestPort: pick a usable HTTP port. If `desired` is free and not reserved, keep it. Otherwise
// scan upward from 3060 (the brief's suggested alternate band) for the first free, non-reserved
// port. `isTaken(port)` is injected so this stays pure and testable (real caller probes a bind).
export function suggestPort(desired, isTaken, { reserved = RESERVED_PORTS, floor = 3060 } = {}) {
  const taken = (p) => reserved.includes(p) || isTaken(p);
  if (!taken(desired)) return desired;
  for (let p = Math.max(floor, desired + 1); p < desired + 1000; p++) {
    if (!taken(p)) return p;
  }
  return desired; // exhausted — let the caller surface it; never silently loop forever
}

// A port string is valid if it's an integer in the ephemeral-safe user range.
export function parsePort(input, fallback = DEFAULT_PORT) {
  const n = Number.parseInt(String(input).trim(), 10);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return { ok: false, port: fallback };
  return { ok: true, port: n };
}

// Basic sanity for a broker address: must look like a ws:// or wss:// URL. Empty → keep default
// (handled by caller). We don't hard-fail on odd input, just report so the caller can warn.
export function validateBroker(input) {
  const s = String(input).trim();
  if (!s) return { ok: true, value: '', empty: true };
  const ok = /^wss?:\/\/[^\s]+$/i.test(s);
  return { ok, value: s, empty: false };
}

// mergeConfig: take the existing parsed config.json object and a patch of only the keys the user
// changed, returning the pretty-printed strict-JSON text to write (stable key handling, trailing
// newline). Never drops unrelated keys the daemon or user added.
export function mergeConfig(existing, patch) {
  const base = existing && typeof existing === 'object' ? existing : {};
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = v;
  }
  return JSON.stringify(out, null, 2) + '\n';
}

// parseVersion: pull the first x.y.z out of a version string (e.g. `ours-mcp v0.9.9`), matching
// install.sh's `grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1`. Returns '' when none is present.
export function parseVersion(text) {
  const m = String(text || '').match(/[0-9]+\.[0-9]+\.[0-9]+/);
  return m ? m[0] : '';
}

// parseStatus: read the daemon's RESOLVED broker + port out of `ours-mcp status` output, so we
// prompt with what the daemon is actually using rather than a hardcoded guess. Returns
// { broker, port } with either field null when the line isn't present (daemon stopped / older
// build). Lines look like:  "  broker: wss://broker1.ours.network"  and
// "  url:    http://localhost:3050/mcp (reachable)".
export function parseStatus(text) {
  const s = String(text || '');
  const bm = s.match(/^\s*broker:\s*(\S+)/m);
  const pm = s.match(/url:\s*https?:\/\/[^:\s/]+:(\d+)/i);
  return {
    broker: bm ? bm[1] : null,
    port: pm ? Number.parseInt(pm[1], 10) : null,
  };
}

// ===============================================================================================
// v2 unified-installer logic (all pure — the orchestrator injects the real probe/uname/env).
// ===============================================================================================

// detectPlatform: classify the host from process.platform + the kernel release string + env.
// - darwin              → macOS  (supported)
// - linux + microsoft/WSL in release, or WSL_* env  → WSL  (supported)
// - linux               → Linux  (supported)
// - win32               → Windows (NOT supported in v1 — the caller prints a WSL pointer + exits)
// - anything else       → unknown (unsupported)
// Returns { os, label, supported }.
export function detectPlatform({ platform, release = '', env = {} } = {}) {
  const rel = String(release).toLowerCase();
  const isWsl = !!(env.WSL_DISTRO_NAME || env.WSL_INTEROP) || /microsoft|wsl/.test(rel);
  switch (platform) {
    case 'darwin': return { os: 'macos', label: 'macOS', supported: true };
    case 'linux':
      return isWsl
        ? { os: 'wsl', label: 'Windows (WSL)', supported: true }
        : { os: 'linux', label: 'Linux', supported: true };
    case 'win32': return { os: 'windows', label: 'Windows (native)', supported: false };
    default: return { os: 'unknown', label: platform || 'unknown', supported: false };
  }
}

// classifyHarnessProbe: turn what we observed about a harness command into a safety verdict,
// WITHOUT ever having called it unsafely. Inputs (all gathered by the orchestrator):
//   onPath      — `command -v <name>` found an executable on PATH
//   versionOk   — a non-interactive `<name> --version` returned 0 promptly with sane output
//   timedOut    — that probe had to be killed (an interactive/hanging wrapper — NEVER call it)
//   shellType   — `type -t <name>` in the user's shell: 'alias' | 'function' | 'file' | ''
// Verdict.status:
//   'ok'      — a real binary that answers --version → safe to drive
//   'alias'   — shadowed by a shell alias/function (or a wrapper that hangs) → do NOT call it,
//               tell the user plainly + how to fix, and ALWAYS still offer a manual path
//   'unsafe'  — on PATH but the probe failed/looked wrong → don't auto-drive; offer manual path
//   'absent'  — genuinely not installed → this harness is skipped (with a note)
// The golden rule (owner edit #3): 'alias'/'unsafe'/'absent' NEVER dead-end — the caller always
// prints a manual-install path so the component still gets installed.
export function classifyHarnessProbe({ onPath, versionOk, timedOut, shellType = '' } = {}) {
  if (versionOk) return { status: 'ok', detail: 'real program' };
  if (timedOut) return { status: 'alias', detail: 'a wrapper that did not answer --version' };
  const t = String(shellType).toLowerCase();
  if (t === 'alias' || t === 'function') {
    return { status: 'alias', detail: `a shell ${t}, not the real command` };
  }
  if (onPath) return { status: 'unsafe', detail: 'found, but did not answer --version' };
  return { status: 'absent', detail: 'not installed' };
}

// harnessAvailable: a harness we can safely DRIVE headlessly right now.
export function harnessAvailable(status) { return status === 'ok'; }

// buildHandoffPrompt: the literal copy-paste hand-off text (delta #1861). Steps for components
// that were NOT installed drop out and the remaining steps renumber, so the user never sees an
// instruction for a piece they don't have. `opts` flags which optional components are present.
// Returns { text } — the exact prompt string the user pastes into Claude Code / Codex.
export function buildHandoffPrompt({ fleet = false, telegram = false } = {}) {
  const steps = [];
  steps.push(
    'Create my Ours human identity — this is me, the human; my agents act on\n' +
    '   my behalf. Ask me what name others should see, then create it.',
  );
  if (fleet) {
    steps.push(
      "Set up ours-fleet: confirm it's ready and show me how to spawn a\n" +
      '   temporary agent, then spawn one so I can see it.',
    );
  }
  if (telegram) {
    steps.push(
      'Set up my Telegram bot: ask me for my bot\'s name and its token from\n' +
      '   @BotFather, register the bot, create a chat↔agent connection, and\n' +
      '   give me the invite link to send.',
    );
  }
  const numbered = steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
  const text =
    'I just installed the ours.network stack. Please help me finish setup, one\n' +
    'step at a time, explaining as you go:\n\n' +
    numbered + '\n\n' +
    'Do these in order, wait for my answers, and tell me if you need anything\n' +
    "from me. Don't assume — ask.";
  return { text };
}

// summarizeComponent: normalize one component's outcome into a summary row the final screen and
// the report share. state ∈ 'installed'|'skipped'|'failed'|'current'. Pure formatting only.
export function summarizeComponent({ key, label, state, version = '', note = '' }) {
  const mark = state === 'failed' ? '✗' : state === 'skipped' ? '·' : '✓';
  return { key, label, state, version, note, mark };
}
