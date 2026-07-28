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

// ── Release CHANNEL / npm dist-tag selection (owner 2026-07-17) ─────────────────
// The installer normally installs everything at @latest (stable). Setting
// OURS_CHANNEL=nightly (or OURS_INSTALL_CHANNEL) makes it install the NIGHTLY tag
// for the packages that HAVE a nightly (mcp, tg-connector, and the harness-plugin
// launchers claude-code/codex/hermes — all lockstep-published to the `nightly` tag),
// but keep @ours.network/fleet at @latest ALWAYS: ours-fleet lives in its own repo
// and publishes NO nightly tag, so `@nightly` there would 404 the whole install.
export const DEFAULT_CHANNEL = 'latest';

// Packages that follow the selected channel (nightly ⇒ @nightly). Short keys map to
// the @ours.network/<key> npm name. NOTE fleet is deliberately ABSENT — it is pinned.
const CHANNEL_TRACKING_PKGS = new Set(['mcp', 'tg-connector', 'claude-code', 'codex', 'hermes']);
// Packages ALWAYS pinned to @latest regardless of channel (no nightly tag exists).
const STABLE_ONLY_PKGS = new Set(['fleet']);

// Normalize a raw channel selection to 'latest' | 'nightly'. Anything unrecognized
// (incl. undefined/'') falls back to the safe default 'latest' — never guesses a tag.
export function resolveChannel(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (v === 'nightly' || v === 'prerelease' || v === 'next') return 'nightly';
  return DEFAULT_CHANNEL; // 'latest' and everything else
}

// The npm dist-tag to install for one package key under a channel. fleet is ALWAYS
// 'latest'; channel-tracking packages take the channel; anything else defaults to 'latest'.
export function pkgTag(pkgKey, channel = DEFAULT_CHANNEL) {
  const key = String(pkgKey || '').replace(/^@ours\.network\//, '');
  if (STABLE_ONLY_PKGS.has(key)) return 'latest';
  const ch = resolveChannel(channel);
  if (ch === 'nightly' && CHANNEL_TRACKING_PKGS.has(key)) return 'nightly';
  return 'latest';
}

// Full `@ours.network/<key>@<tag>` spec for `npm i -g`, honoring the channel.
export function pkgSpec(pkgKey, channel = DEFAULT_CHANNEL) {
  const key = String(pkgKey || '').replace(/^@ours\.network\//, '');
  return `@ours.network/${key}@${pkgTag(key, channel)}`;
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

export const VOICE_PROVIDERS = ['openai-compatible', 'elevenlabs', 'deepgram', 'custom'];

// Resolve only the STT fields the daemon itself accepts. Environment values override
// config.json field-by-field, matching packages/core/src/config.ts. The returned object
// may contain a secret, so callers must never print or serialize it into diagnostics.
export function effectiveVoiceConfig(config = {}, env = {}) {
  const file = config?.stt && typeof config.stt === 'object' ? config.stt : {};
  const out = { ...file };
  const envFields = {
    provider: env.OURS_STT_PROVIDER,
    apiKey: env.OURS_STT_API_KEY,
    model: env.OURS_STT_MODEL,
    baseUrl: env.OURS_STT_BASE_URL,
    language: env.OURS_STT_LANGUAGE,
  };
  for (const [key, raw] of Object.entries(envFields)) {
    if (typeof raw === 'string' && raw.trim()) out[key] = raw.trim();
  }
  return out;
}

// Capability/readiness check, deliberately based on required fields rather than a package
// version. Reasons contain field names only — never secret values.
export function voiceSetupStatus(config = {}, env = {}) {
  const stt = effectiveVoiceConfig(config, env);
  const provider = String(stt.provider || '').trim().toLowerCase();
  if (!provider) return { ready: false, provider: '', reason: 'no voice provider configured', missing: ['provider'] };
  if (!VOICE_PROVIDERS.includes(provider)) {
    return { ready: false, provider, reason: `unsupported voice provider "${provider}"`, missing: ['provider'] };
  }
  if (!String(stt.apiKey || '').trim()) {
    return { ready: false, provider, reason: `voice provider "${provider}" is missing its API key`, missing: ['apiKey'] };
  }
  if (provider === 'openai-compatible') {
    const missing = [];
    if (!String(stt.baseUrl || '').trim()) missing.push('baseUrl');
    if (!String(stt.model || '').trim()) missing.push('model');
    if (missing.length) return { ready: false, provider, reason: `openai-compatible voice setup is missing ${missing.join(' and ')}`, missing };
  }
  if (provider === 'elevenlabs' && !String(stt.model || '').trim()) {
    return { ready: false, provider, reason: 'elevenlabs voice setup is missing model', missing: ['model'] };
  }
  if (provider === 'custom') {
    if (!String(stt.custom?.url || '').trim()) {
      return { ready: false, provider, reason: 'custom voice setup is missing custom.url', missing: ['custom.url'] };
    }
    const wantsModel = stt.custom.url.includes('{model}')
      || (stt.custom.modelField !== undefined && stt.custom.modelField !== '');
    if (wantsModel && !String(stt.model || '').trim()) {
      return { ready: false, provider, reason: 'custom voice setup references a model but model is missing', missing: ['model'] };
    }
  }
  return {
    ready: true,
    provider,
    reason: 'voice transcription is configured',
    missing: [],
    keySource: typeof env.OURS_STT_API_KEY === 'string' && env.OURS_STT_API_KEY.trim() ? 'environment' : 'config',
  };
}

// Provider keys have different shapes, so validation is intentionally conservative: reject
// empty, tiny, whitespace-containing, or control-character input without assuming a vendor prefix.
export function validateVoiceSecret(input) {
  const value = String(input || '').trim();
  if (value.length < 8) return { ok: false, reason: 'API key must contain at least 8 characters' };
  if (/[\s\x00-\x1f\x7f]/.test(value)) return { ok: false, reason: 'API key must not contain whitespace or control characters' };
  return { ok: true, value };
}

// Last-resort diagnostic scrubber. Code should avoid putting secrets into errors in the first
// place; this protects unexpected provider/tool errors before they reach a terminal or log.
export function redactSensitive(text, secrets = []) {
  let out = String(text ?? '');
  for (const raw of secrets) {
    const secret = String(raw || '');
    if (secret) out = out.split(secret).join('[redacted]');
  }
  return out
    .replace(/("(?:apiKey|apiToken|token)"\s*:\s*")[^"]*(")/gi, '$1[redacted]$2')
    .replace(/((?:api[_ -]?key|token)\s*[=:]\s*)\S+/gi, '$1[redacted]');
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
// instruction for a piece they don't have. The human identity is normally created DURING install,
// so its step is included ONLY as a fallback (identity: true) when in-install creation was skipped
// or failed. Returns { text, empty } — empty is true when there is nothing left to finish.
export function buildHandoffPrompt({ identity = false, fleet = false, telegram = false } = {}) {
  const steps = [];
  if (identity) {
    steps.push(
      'Create my Ours human identity — this is me, the human; my agents act on\n' +
      '   my behalf. Ask me what name others should see, then create it.',
    );
  }
  if (fleet) {
    steps.push(
      'Set up my ours-fleet: ask me what agents I want in my fleet for\n' +
      '   PERMANENT use (a name + role/purpose for each), then create and\n' +
      '   configure those permanent fleet agents for me.',
    );
  }
  if (telegram) {
    steps.push(
      'Set up my Telegram bot: ask me for my bot\'s name and its token from\n' +
      '   @BotFather, register the bot, create a chat↔agent connection, and\n' +
      '   give me the invite link to send.',
    );
  }
  if (steps.length === 0) return { text: '', empty: true };
  const numbered = steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
  const text =
    'I just installed the ours.network stack. Please help me finish setup, one\n' +
    'step at a time, explaining as you go:\n\n' +
    numbered + '\n\n' +
    'Do these in order, wait for my answers, and tell me if you need anything\n' +
    "from me. Don't assume — ask.";
  return { text, empty: false };
}

// summarizeComponent: normalize one component's outcome into a summary row the final screen and
// the report share. state ∈ 'installed'|'skipped'|'failed'|'current'. Pure formatting only.
export function summarizeComponent({ key, label, state, version = '', note = '' }) {
  const mark = state === 'failed' ? '✗' : state === 'skipped' ? '·' : '✓';
  return { key, label, state, version, note, mark };
}
