#!/usr/bin/env node
// ours.network — the unified `ours-install` experience (the real UX behind install.sh's thin
// bootstrap, and the `ours-install` command once the stack is on the machine).
//
// ONE installer for the WHOLE stack — the shared ours daemon + the harness plugins (Claude Code /
// Codex / Hermes) + ours-fleet + the Telegram connector + Rooms (ours-cowork) — for someone who
// ALREADY has Claude, Codex, and/or Hermes.
//
// TOPOLOGY. Step 1 installs and configures ONE shared daemon and the user picks its listen port
// there; every consumer below is wired to that endpoint. The Telegram connector may instead be
// given its OWN daemon — its own port, state directory and boot unit — chosen independently, and
// defaulting to the shared one so Enter and non-interactive runs keep the historical topology.
// Rooms answers the same question, plus a third answer the connector has no use for: keeping
// cowork's own EMBEDDED daemon, which is what every pre-PR#9 cowork install runs (see step 5).
// Its whole job: install the stack cleanly, then hand back ONE copy-paste prompt the user drops
// into their agent to finish remaining configuration conversationally. Voice API credentials are
// the one guided secret flow: interactive, masked, optional, and written atomically with mode 0600.
// See packages/installer/README.md and the UX spec for the full contract.
//
// Design pillars (from the spec): config FIRST then act once; consent-first (Enter = no change);
// slow, per-step "✓ … no problems" + Continue?; never silently broken; idempotent + safe re-run;
// alias-safety / never-hang; most deep config deferred to the copy-paste hand-off.
//
// SAFETY: every side-effecting action goes through act(); with OURS_INSTALL_DRY_RUN=1 nothing is
// installed/started/restarted — it prints exactly what it WOULD do. That is the safe way to walk
// the whole flow on a machine you don't want to touch (and how the tests drive it).
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { homedir, userInfo, platform as osPlatform, release as osRelease } from 'node:os';
import { join, resolve } from 'node:path';
import { banner, heading, ok, info, warn, c, box, withSpinner, openTty, makeWriter, closeSync } from './lib/ui.mjs';
import { askLine, askYesNo, isCancel } from './lib/prompt.mjs';
import {
  suggestPort, parsePort, validateBroker, mergeConfig, parseVersion, parseStatus,
  detectPlatform, classifyHarnessProbe, buildHandoffPrompt,
  voiceSetupStatus, resolveSharedBroker, tgConfigPath, planTgDaemonConfig, daemonEndpoint,
  DEFAULT_PORT, resolveChannel, pkgSpec,
  validateDaemonPort, planPorts, dedicatedDaemonPaths, DEDICATED_INSTANCES,
  coworkConfigPath, planCoworkConfig, COWORK_DEFAULT_PORT, coworkDaemonMode,
  coworkSupportsExternalDaemon, COWORK_EXTERNAL_MIN_VERSION,
} from './lib/logic.mjs';
import { atomicWriteConfig } from './lib/config.mjs';
import { runNightlyInstaller } from './lib/nightly-install.mjs';

const NPM = process.env.OURS_NPM || 'npm';
// Release channel: OURS_CHANNEL=nightly installs each package's PRERELEASE dist-tag —
// @nightly for mcp/tg-connector/fleet/the plugin launchers, and @latest for cowork,
// and @next for cowork, whose repo has always called its prerelease line `next`
// (see PKG_CHANNEL_TAGS in lib/logic.mjs). With no explicit
// selection the installer follows its OWN channel, so a nightly installer builds a
// nightly stack instead of silently mixing tags across an architecture boundary.
const CHANNEL = resolveChannel(process.env.OURS_CHANNEL || process.env.OURS_INSTALL_CHANNEL, pkgVersion());
const spec = (pkgKey) => pkgSpec(pkgKey, CHANNEL); // → "@ours.network/<key>@<tag>"
let DRY = !!process.env.OURS_INSTALL_DRY_RUN;
const SELFHOST_URL = 'ours.network';
const CLAUDE_MARKET = 'adapt-toolkit/ours-claude-marketplace';
const CODEX_MARKET = 'adapt-toolkit/ours-codex-marketplace';

const sink = (s) => process.stdout.write(s);
const line = (s = '') => sink(`${s}\n`);
const say = (s) => sink(`ours: ${s}\n`);

// --- external command helpers (never throw; the installer degrades, it doesn't crash) ----------
function run(bin, args, { capture = false, timeout, env } = {}) {
  const r = spawnSync(bin, args, {
    encoding: 'utf8',
    timeout,
    env: env ? { ...process.env, ...env } : process.env,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  const timedOut = !!(r.error && (r.error.code === 'ETIMEDOUT' || r.signal === 'SIGTERM'));
  return {
    code: r.status ?? (r.error ? -1 : 0),
    out: r.stdout || '', err: r.stderr || '',
    ok: !r.error && r.status === 0,
    timedOut,
  };
}
function runAsync(bin, args) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { resolve({ code: -1, out: '', err: '', ok: false }); return; }
    let out = '', errOut = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { errOut += d; });
    child.on('error', () => resolve({ code: -1, out, err: errOut, ok: false }));
    child.on('close', (code) => resolve({ code: code ?? -1, out, err: errOut, ok: code === 0 }));
  });
}

// act(): the single seam every side-effecting step passes through. In DRY-RUN it prints the exact
// command instead of running it and reports a synthetic success, so the whole UX can be walked on
// a machine we must not disturb. `fn` runs the real thing and returns {ok,...}.
async function act(desc, fn) {
  if (DRY) { line('  ' + c.dim(`[dry-run] would: ${desc}`)); return { ok: true, dry: true }; }
  return fn();
}
async function actSpin(label, desc, fn) {
  if (DRY) { line('  ' + c.dim(`[dry-run] would: ${desc}`)); return { ok: true, dry: true }; }
  return withSpinner(label, fn);
}

// --- daemon probes (always safe to run — read-only) --------------------------------------------
const daemonVersionLine = () => (run('ours-mcp', ['--version'], { capture: true }).out.split('\n')[0] || '').trim();
const daemonStatusText = () => run('ours-mcp', ['status'], { capture: true }).out;
function daemonLifecycleState() {
  const status = run('ours-mcp', ['status'], { capture: true });
  if (!status.ok) return 'stopped';
  return /^\s*pid:\s*\d+/m.test(status.out) ? 'managed' : 'external';
}
const daemonRunning = () => daemonLifecycleState() !== 'stopped';
// The installed version of a global package, INCLUDING any prerelease suffix. The
// suffix is not cosmetic here: the Rooms daemon guard compares against an exact
// `0.4.1-nightly.<date>.<sha>` floor, and truncating at the dash would make every
// 0.4.1 nightly look alike — including ones published before the mode existed.
const globalVersion = (pkg) => {
  const ls = run(NPM, ['ls', '-g', pkg], { capture: true }).out;
  const m = ls.match(new RegExp(pkg.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') + '@(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)'));
  return m ? m[1] : '';
};

// --- config file (fixed home location; mirrors core/config.ts) ---------------------------------
function configPath() { return process.env.OURS_CONFIG || join(homedir(), '.ours', 'config.json'); }
function readConfigObject() { try { return JSON.parse(readFileSync(configPath(), 'utf8')); } catch { return {}; } }
function writeConfigPatch(patch) {
  const p = configPath();
  atomicWriteConfig(p, mergeConfig(readConfigObject(), patch));
  return p;
}

// The daemon's state directory, resolved exactly the way packages/core/src/config.ts
// resolves it (env > config file > ~/.ours). The Telegram connector needs the ABSOLUTE
// path: the SDK reads the daemon's API token from it and refuses to send that token to
// a separately-chosen endpoint unless the state dir was chosen just as deliberately.
function daemonStateDir() {
  const fromEnv = process.env.OURS_STATE_DIR?.trim();
  if (fromEnv) return resolve(fromEnv);
  const fromFile = readConfigObject().stateDir;
  if (typeof fromFile === 'string' && fromFile.trim()) return resolve(fromFile.trim());
  return join(homedir(), '.ours');
}

function daemonVoiceCapability() {
  const r = run('ours-mcp', ['voice-status', '--json'], { capture: true, timeout: 6000 });
  if (!r.ok) return null;
  try {
    const parsed = JSON.parse(r.out.trim());
    return typeof parsed?.ready === 'boolean' ? parsed : null;
  } catch {
    return null;
  }
}

// Block the thread for `ms` without a subprocess — used for the brief daemon-reachability wait
// before creating the human identity (a freshly-started daemon needs a moment to bind its port).
function sleepMs(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* ignore */ }
}

// Is `port` already bound? Probe in a throwaway child and read its exit code (EADDRINUSE ⇒ taken).
function portTakenSync(port) {
  const scriptSrc = `const net=require('net');const s=net.createServer();s.once('error',e=>{process.exit(e.code==='EADDRINUSE'?3:0)});s.listen(${port},'127.0.0.1',()=>{s.close(()=>process.exit(0))});`;
  const r = spawnSync(process.execPath, ['-e', scriptSrc], { timeout: 3000 });
  return r.status === 3;
}

// --- harness detection with ALIAS-SAFETY (never call an unsafe command) -------------------------
// Gather three read-only observations, then let the pure classifier decide. We NEVER run the
// harness in a way that could hang: --version is spawned directly (no shell → real PATH binary)
// with a hard timeout; the shell `type` lookup is also timeout-guarded.
function detectHarness(name) {
  const onPath = run('bash', ['-c', `command -v ${name}`], { capture: true }).ok;
  const probe = run(name, ['--version'], { capture: true, timeout: 6000 });
  const versionOk = probe.ok && /\d+\.\d+/.test(probe.out);
  const shell = process.env.SHELL || '/bin/bash';
  const typeProbe = run(shell, ['-ic', `type -t ${name} 2>/dev/null`], { capture: true, timeout: 4000 });
  const shellType = (typeProbe.out || '').trim();
  const verdict = classifyHarnessProbe({ onPath, versionOk, timedOut: probe.timedOut, shellType });
  return { name, ...verdict };
}

// Hermes detection is DIFFERENT from Claude Code / Codex: Hermes has no driven CLI. Its ours plugin
// (`ours-hermes-install`) never calls a `hermes` binary — it just writes ~/.hermes/config.yaml + the
// skills — so "is it drivable?" is the wrong question. Per the Hermes plugin's own prerequisites,
// presence == the config dir (~/.hermes, override with HERMES_DIR) exists. We still run the alias-safe
// CLI probe in case a real `hermes` command is on PATH, purely to enrich detection; either signal
// makes it installable. No config dir and no CLI → absent (skipped, like an uninstalled harness).
function detectHermes() {
  const dir = process.env.HERMES_DIR || join(homedir(), '.hermes');
  const dirPresent = existsSync(dir);
  const cli = detectHarness('hermes'); // best-effort — Hermes usually has no `--version` CLI
  const status = dirPresent || cli.status === 'ok' ? 'ok' : 'absent';
  const detail = dirPresent ? `config dir ${dir} present` : cli.detail;
  return { name: 'hermes', label: 'Hermes', status, detail };
}

// Set by main() so the top-level catch can route a Ctrl+C (InstallCancelled) through the same
// clean-exit path as the SIGINT handler.
let cancelHandler = null;

// A tiny package version read (best-effort) for `--version`.
function pkgVersion() {
  try { return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version || '?'; }
  catch { return '?'; }
}
const USAGE = `ours-install — the unified ours.network stack installer.

  Install:  npm i -g @ours.network/install && ours-install   (recommended)
            npx @ours.network/install                          (one-off)

  ours-install [--dry-run] [--help] [--version]

Guided ~3-minute setup for the whole stack: the shared ours daemon (you pick its
port), the harness plugins (Claude Code + Codex + Hermes), ours-fleet, the Telegram
connector, and Rooms (ours-cowork) — then one copy-paste hand-off prompt. You approve
each step; re-run any time to add a piece or update.

Telegram can share the daemon from step 1 or be given its own (its own port, state
directory and boot service); Enter keeps the shared one.

  --dry-run    walk the whole flow and print what it WOULD do — install/change nothing
  --help       show this help and exit
  --version    print the installer version and exit

Env: OURS_ASSUME_YES=1 (accept defaults, no prompts) · OURS_INSTALL_DRY_RUN=1 ·
     OURS_NPM · OURS_CONFIG (default ~/.ours/config.json). Docs: https://ours.network`;

// ===============================================================================================
async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write(USAGE + '\n'); return; }
  if (argv.includes('--version') || argv.includes('-V')) { process.stdout.write(`ours-install v${pkgVersion()}\n`); return; }
  if (argv.includes('--dry-run')) DRY = true;

  const ttyFd = openTty();
  const interactive = ttyFd != null && !process.env.OURS_ASSUME_YES;
  const write = makeWriter(ttyFd);

  // Ctrl+C at ANY prompt aborts cleanly (never the old "^C^C^C and keeps going"): print one line
  // and exit 130. The SIGINT handler covers a ^C while we're idle/spinning; the InstallCancelled
  // thrown out of a blocked prompt read covers a ^C mid-prompt (both routed here, guarded once).
  let cancelling = false;
  const cancel = () => {
    if (cancelling) return; cancelling = true;
    try { process.stdout.write('\n' + warn('Installation cancelled — re-run any time.') + '\n'); } catch { /* ignore */ }
    finish(ttyFd);
    process.exit(130);
  };
  cancelHandler = cancel;
  if (interactive) process.on('SIGINT', cancel);
  const yes = (prompt, def) => (process.env.OURS_ASSUME_YES ? def : askYesNo(write, ttyFd, prompt, def));
  const ask = (prompt, def) => (process.env.OURS_ASSUME_YES ? def : askLine(write, ttyFd, prompt, def));
  // A Continue? beat: one clean acknowledgement AFTER a step that actually did something (delta
  // #1860). A step the user SKIPPED (answered No) shows no "you skipped — press Enter" pause — we
  // move straight on. No-op when we can't prompt (headless / assume-yes) so scripted runs stay linear.
  const cont = (acted = true) => { if (interactive && acted) askLine(write, ttyFd, '  ' + c.gray('Continue?  [Enter] '), ''); };

  line(banner());
  say('setting up the ours.network stack — ours core, your harness plugins, ours-fleet, Telegram.');
  line('  ' + c.dim('~3 minutes. You approve each step; re-run any time to add a piece or update.'));
  if (DRY) line('  ' + c.yellow('(dry-run: nothing will be installed or changed — this just walks the flow.)'));

  // ============================================================================================
  // PRE-FLIGHT — silent-ish checks, no changes. Detect the disasters up front. A checklist, not
  // logs. (Native Windows → WSL pointer + exit; no harness at all → tell them + exit.)
  // ============================================================================================
  line(heading('Checking your machine'));
  const plat = detectPlatform({ platform: osPlatform(), release: osRelease(), env: process.env });
  if (!plat.supported) {
    if (plat.os === 'windows') {
      line(warn(`${plat.label} isn't supported directly yet.`));
      line(info('Install this inside WSL (Windows Subsystem for Linux), then re-run there:'));
      line('    ' + c.cyan('https://learn.microsoft.com/windows/wsl/install'));
    } else {
      line(warn(`Platform "${plat.label}" isn't supported. ours runs on Linux, macOS, or WSL.`));
    }
    finish(ttyFd); return;
  }
  line(ok(`Platform: ${plat.label} (supported)`));

  const nodeMajor = Number.parseInt((process.versions.node || '0').split('.')[0], 10);
  if (nodeMajor >= 20) line(ok(`Node.js ${process.versions.node}`));
  else { line(warn(`Node.js ${process.versions.node} — ours needs v20 or newer. Update Node and re-run.`)); finish(ttyFd); return; }

  // Harness detection with alias-safety. Report each, keep the drivable ones.
  const harnessSpecs = [
    { name: 'claude', label: 'Claude Code' },
    { name: 'codex', label: 'Codex' },
  ];
  // Claude Code + Codex are driven CLIs (alias-safe --version probe); Hermes is config-dir based
  // (see detectHermes) so it gets its own detector, appended after them.
  const harnesses = harnessSpecs.map((h) => ({ ...h, ...detectHarness(h.name) }));
  harnesses.push(detectHermes());
  for (const h of harnesses) {
    if (h.status === 'ok') line(ok(`'${h.name}'  → real program (its plugin can be installed)`));
    else if (h.status === 'alias') line(warn(`'${h.name}'  → ${h.detail}  (I won't call it — see the note below; you can still install it by hand)`));
    else if (h.status === 'unsafe') line(warn(`'${h.name}'  → on your PATH but didn't answer safely  (manual install shown below if you want it)`));
    else line(info(`'${h.name}'  → not installed  (skipped — install it first if you want it wired up)`));
  }

  const anyHarness = harnesses.some((h) => h.status !== 'absent');
  if (!anyHarness) {
    line('');
    line(warn('No Claude Code, Codex, or Hermes found on this machine.'));
    line(info('Install one of them first, then re-run ours-install to wire it up.'));
    finish(ttyFd); return;
  }

  // HARD RELEASE BOUNDARY. Nightly owns the topology-first profile flow. The
  // latest/stable consumer-first implementation below remains untouched and
  // never reads or writes installer-profiles.json or emits --application.
  if (CHANNEL === 'nightly') {
    return runNightlyInstaller({
      harnesses, ttyFd, interactive, write, yes, ask, cont, dry: DRY,
      npm: NPM, run, runAsync, act, actSpin, finish,
    });
  }

  // Daemon state up front (decides first-install vs update, and whether Step 0 runs at all).
  const versionBefore = daemonVersionLine();
  const daemonInstalled = !!versionBefore;
  line(daemonInstalled
    ? ok(`ours core already present (${versionBefore})`)
    : ok('No ours daemon yet — will offer to install it'));
  line('');
  cont();

  const status0 = parseStatus(daemonStatusText());
  let chosenBroker;     // undefined = keep default / existing
  let chosenPort = status0.port || DEFAULT_PORT;
  const configFirst = !daemonInstalled;

  // Every port this run has committed to, so a later daemon can't be handed one an
  // earlier daemon claimed. A live bind probe cannot see these — nothing is
  // listening on them yet — which is exactly why they're tracked by hand.
  const claimedPorts = [];
  // The finished topology, for the end-of-run cross-check. Each entry is one thing that
  // will try to BIND a port, named so a collision can be reported in the user's terms.
  const topology = [];
  const claimPort = (port, label) => {
    if (!Number.isInteger(port)) return;
    if (!claimedPorts.includes(port)) claimedPorts.push(port);
    if (label) topology.push({ label, port });
  };

  // Ask for ONE daemon's port, validate it, and keep asking until the answer is
  // usable. Enter (and every non-interactive run) takes `def` unchanged — that is
  // what keeps the historical behaviour and scripted installs identical.
  const askDaemonPort = (prompt, def) => {
    let candidate = def;
    for (let attempt = 0; attempt < 3; attempt++) {
      const raw = ask(`  ${prompt}  ${c.gray(`[Enter for ${candidate}]`)}: `, String(candidate));
      const v = validateDaemonPort(raw, { fallback: candidate, isTaken: portTakenSync, taken: claimedPorts });
      if (v.ok) return v.port;
      line(warn(`${v.reason}.`));
      if (!interactive) break;   // no one to re-ask; fall through to a suggestion
      candidate = suggestPort(v.port + 1, (p) => claimedPorts.includes(p) || portTakenSync(p));
      line(info(`Suggesting ${candidate} instead.`));
    }
    // Out of attempts (or headless): take the first genuinely free port rather
    // than persisting one we know is unusable.
    const fallback = suggestPort(candidate, (p) => claimedPorts.includes(p) || portTakenSync(p));
    line(ok(`Using port ${fallback}.`));
    return fallback;
  };

  // Track outcomes for the summary + hand-off.
  const summary = [];
  const record = (row) => summary.push(row);

  // Voice setup is part of the core lifecycle, not a follow-up after it. On a
  // fresh install this runs after the CLI is installed/configured but before
  // the first daemon start. On an update it runs before any pending restart;
  // a successful canonical voice-setup owns that one restart/readiness check.
  // Declining, headless skipping, or an already-complete setup leaves the
  // caller's normal start/restart lifecycle untouched.
  const offerVoiceSetup = ({ readinessAfterStart = false, daemonState = 'stopped' } = {}) => {
    line(heading('Voice messages'));
    const cfgBefore = readConfigObject();
    const probed = daemonVoiceCapability();
    const localStatus = voiceSetupStatus(cfgBefore, process.env);
    const voiceStatus = probed ?? localStatus;
    if (voiceStatus.ready) {
      line(ok(`Voice transcription is configured (${voiceStatus.provider}). API key: configured, never displayed.`));
      record({ key: 'voice', label: 'Voice transcription', state: 'current', note: voiceStatus.provider });
      cont(false);
      return { setupRan: false, restartHandled: false };
    }
    if (!interactive) {
      line(info('Voice transcription is not configured. Non-interactive mode leaves it unchanged.'));
      line(info('Run `ours-mcp voice-setup` in a terminal, or supply OURS_STT_* environment values.'));
      record({ key: 'voice', label: 'Voice transcription', state: 'skipped', note: 'interactive setup available on re-run' });
      cont(false);
      return { setupRan: false, restartHandled: false };
    }

    line(info('Voice notes can be transcribed by a provider you choose. Audio is sent to that'));
    line(info('provider; use a self-hosted endpoint if it must stay local. The API key is hidden.'));
    if (!yes('  Set up voice transcription now?', true)) {
      line(info('skipped — this will be offered again on the next installer run.'));
      record({ key: 'voice', label: 'Voice transcription', state: 'skipped', note: 'declined; offered again on re-run' });
      cont(false);
      return { setupRan: false, restartHandled: false };
    }

    line(info('Opening the canonical ours-mcp voice setup (same command you can re-run later).'));
    const setupArgs = ['voice-setup', ...(DRY ? ['--dry-run'] : [])];
    const setup = run('ours-mcp', setupArgs);
    if (!setup.ok) {
      line(warn('Voice setup did not complete; no installer-side credential fallback was used.'));
      line(info('Run `ours-mcp voice-setup` directly to try again.'));
      record({ key: 'voice', label: 'Voice transcription', state: 'failed', note: 'ours-mcp voice-setup did not complete' });
      cont();
      // Exit 2 is the canonical command's explicit signal that it already
      // attempted restart/readiness and rollback. Never layer the pending
      // installer update restart on top of that recovery transaction.
      return { setupRan: true, restartHandled: setup.code === 2 };
    }
    if (DRY) {
      line(ok('Canonical voice setup dry-run completed; no config or daemon state changed.'));
      record({ key: 'voice', label: 'Voice transcription', state: 'current', note: 'voice-setup dry-run' });
      cont();
      return { setupRan: true, restartHandled: false };
    }
    if (readinessAfterStart) {
      line(ok('Voice configuration saved securely; it will be readiness-checked after the first daemon start.'));
      record({ key: 'voice', label: 'Voice transcription', state: 'installed', note: 'configured before first start' });
      cont();
      return { setupRan: true, restartHandled: false };
    }

    const verified = daemonVoiceCapability();
    if (verified?.ready) {
      line(ok(`Voice transcription is ready (${verified.provider}); API key remains hidden.`));
      record({ key: 'voice', label: 'Voice transcription', state: 'installed', note: verified.provider });
    } else {
      line(warn('Voice setup returned without a ready capability; inspect `ours-mcp voice-status`.'));
      record({ key: 'voice', label: 'Voice transcription', state: 'failed', note: 'readiness check failed' });
    }
    cont();
    // Exit 0 also covers config-only success for a stopped daemon or an
    // externally launched daemon. Only a still-managed daemon proves that
    // canonical setup owned apply + readiness and may suppress an update
    // restart.
    return {
      setupRan: true,
      restartHandled: daemonState === 'managed' && daemonLifecycleState() === 'managed',
    };
  };

  // ============================================================================================
  // STEP 1 / 5 — the SHARED ours daemon. Its own visible step, and it owns its own configuration
  // (broker + listen port) rather than a nameless "quick settings" preamble: every consumer below
  // is wired to the endpoint chosen HERE, so the choice belongs to the step that makes it.
  // Config-first within the step: choose → write config → optional voice → start ONCE.
  // ============================================================================================
  line(heading('1/5 — the shared ours daemon'));
  line(info('This is the piece that lets your agents talk to each other securely. The harness'));
  line(info('plugins, ours-fleet and the Telegram connector all connect to it — Telegram can be'));
  line(info('given its own instead, later — and so can Rooms.'));
  const before = parseVersion(versionBefore);

  if (configFirst) {
    // Broker (owner edit #1: SECURE wording; owner edit #2: self-host → website only).
    line('');
    line(info('Your agents connect through a "broker" — a shared meeting point that lets them find'));
    line(info("each other. It's secure: your messages are end-to-end encrypted, so the broker never"));
    line(info('sees what they say. Almost everyone uses the standard one — just press Enter.'));
    const custom = yes('  Use a custom broker address?', false);
    if (custom) {
      line(info(`(Only needed if you run your own broker. More at ${SELFHOST_URL}.)`));
      const entered = ask('  Enter the broker address: ', '');
      const v = validateBroker(entered);
      if (entered && v.ok && !v.empty) {
        // Undo safety net: a mistaken custom entry is one keystroke back to the standard broker.
        const keep = yes(`  Use "${v.value}"?  (No = go back to the standard broker)`, true);
        if (keep) { chosenBroker = v.value; line(ok(`broker set to ${chosenBroker}.`)); }
        else line(ok('using the standard broker.'));
      } else {
        if (entered) line(warn(`"${entered}" doesn't look like a ws:// address — using the standard broker.`));
        else line(ok('using the standard broker.'));
      }
    } else {
      line(ok('using the standard broker.'));
    }

    // Listen port. ALWAYS asked now, so the shared daemon's endpoint is a decision the
    // user makes rather than one they only hear about when 3050 happens to be busy.
    // The default is still 3050 (the next free port when it is taken), so Enter and
    // every non-interactive run land exactly where they always did.
    line('');
    line(info('The daemon listens on a local port. Everything else in this install is pointed at it.'));
    const portDefault = portTakenSync(DEFAULT_PORT) ? suggestPort(DEFAULT_PORT + 1, portTakenSync) : DEFAULT_PORT;
    if (portDefault !== DEFAULT_PORT) line(info(`The standard port (${DEFAULT_PORT}) is already in use on your machine.`));
    chosenPort = askDaemonPort('Which local port should the shared daemon use?', portDefault);
    line(ok(`Shared daemon: port ${chosenPort}, broker ${chosenBroker ? 'custom' : 'standard'}.`));
    line('');
  } else {
    line(ok(`Shared daemon already configured — port ${chosenPort}. Keeping it.`));
  }
  claimPort(chosenPort, 'the shared ours daemon');

  if (!daemonInstalled) {
    const goCore = yes('  Install and start it?', true);
    if (!goCore) {
      line(info("skipped — nothing else can run without it. Re-run ours-install when you're ready."));
      record({ key: 'core', label: 'ours core (daemon)', state: 'skipped', note: 'declined' });
      // Without a daemon the rest is moot; go straight to the summary.
      return endScreen({ ttyFd, summary, chosenPort, chosenBroker });
    }
    await actSpin(`ensuring ${spec('mcp')}…`, `npm i -g ${spec('mcp')}`, () => runAsync(NPM, ['i', '-g', spec('mcp')]));
    const patch = { port: chosenPort };
    if (chosenBroker) patch.brokerUrl = chosenBroker;
    await act(`write config (${configPath()}) with port ${chosenPort}${chosenBroker ? ' + custom broker' : ''}`, async () => { writeConfigPatch(patch); return { ok: true }; });
    const voice = offerVoiceSetup({ readinessAfterStart: true });
    const started = await act(`ours-mcp start (port ${chosenPort})`, async () => run('ours-mcp', ['start']));
    const svc = await act('ours-mcp install-service (survives reboot)', async () => run('ours-mcp', ['install-service']));
    // `ours-mcp install-service` STOPS the daemon before it writes the unit (core's
    // cmdInstallService), then exits non-zero if `systemctl --user enable --now` fails —
    // no linger, no user bus, a container, WSL without systemd. Left alone that turns a
    // WORKING daemon into no daemon at all, while the line below still said "ready": the
    // human identity and every MCP client then fail against a port nothing is listening
    // on. Put the one shared daemon back up and report what is actually true.
    let running = started.ok;
    if (!DRY && !svc.ok) {
      running = daemonRunning();
      if (!running) {
        line(info('the boot-service step stopped the daemon before it failed — restarting it.'));
        running = run('ours-mcp', ['start']).ok || daemonRunning();
      }
    }
    if (running) line(ok(`ours core ready — running on port ${chosenPort}. No problems.`));
    else line(warn(`could not auto-start — run '${c.cyan('ours-mcp start')}' to bring it up.`));
    if (!svc.ok && !svc.dry) line(warn(`boot-service not installed — retry '${c.cyan('ours-mcp install-service')}' later.`));
    if (voice.setupRan && !DRY && running) {
      const verified = daemonVoiceCapability();
      if (verified?.ready) {
        line(ok(`Voice transcription readiness confirmed (${verified.provider}) after the first start.`));
      } else {
        line(warn('Voice configuration was saved, but readiness was not confirmed after start; run `ours-mcp voice-status`.'));
        const row = summary.find((entry) => entry.key === 'voice');
        if (row) {
          row.state = 'failed';
          row.note = 'readiness check failed after first start';
        }
      }
    }
    record({
      key: 'core',
      label: 'ours core (daemon)',
      state: running ? 'installed' : 'failed',
      version: parseVersion(daemonVersionLine()),
      note: svc.ok ? 'starts on boot' : 'running; no boot service',
    });
  } else {
    // Installed: offer an update; never re-ask config; reuse the running port everywhere.
    const daemonState = daemonLifecycleState();
    const running = daemonState !== 'stopped';
    const upd = yes(`  ours core is installed (${before || '?'}) — check for an update now?`, false);
    let pendingUpdateRestart = false;
    let after = before;
    if (upd) {
      await actSpin(`updating ${spec('mcp')}…`, `npm i -g ${spec('mcp')}`, () => runAsync(NPM, ['i', '-g', spec('mcp')]));
      after = parseVersion(daemonVersionLine());
      pendingUpdateRestart = !!(before && after && before !== after);
    }

    const voice = offerVoiceSetup({ daemonState });
    if (pendingUpdateRestart && !voice.restartHandled) {
      const restartState = daemonLifecycleState();
      if (restartState === 'external') {
        line(warn(`ours core updated (v${before} → v${after}); restart its external launcher to load the update.`));
      } else {
        await act(`ours-mcp restart (now v${after})`, async () => { if (!run('ours-mcp', ['restart']).ok) run('ours-mcp', ['start']); return { ok: true }; });
        line(ok(`ours core updated (v${before} → v${after}) and restarted. No problems.`));
      }
    } else if (pendingUpdateRestart) {
      const voiceFailed = summary.find((entry) => entry.key === 'voice')?.state === 'failed';
      line(voiceFailed
        ? warn(`ours core updated (v${before} → v${after}); voice setup handled restart/rollback but did not change voice settings.`)
        : ok(`ours core updated (v${before} → v${after}); voice setup performed the required restart and readiness check.`));
    } else if (upd) {
      line(ok(`ours core already current${after ? ` (v${after})` : ''} — nothing to change.`));
    } else {
      line(ok(`ours core ready — running on port ${chosenPort}${running ? '' : ' (start with ours-mcp start)'}. No problems.`));
    }
    record({ key: 'core', label: 'ours core (daemon)', state: 'current', version: (parseVersion(daemonVersionLine()) || before), note: `port ${chosenPort}` });
  }
  cont();

  // ============================================================================================
  // Human identity — created DURING install, right after the daemon is confirmed reachable (the
  // owner change that supersedes "defer to the hand-off"). `ours-mcp create-root` is the internal
  // seam; ALL user-facing copy says "human identity". Already-exists is a friendly keep, not an
  // error; an unreachable daemon gives an exact retry command (never "ask your agent later").
  // ============================================================================================
  const coreReady = summary.some((r) => r.key === 'core' && (r.state === 'installed' || r.state === 'current'));
  if (coreReady) {
    line(heading('Your human identity'));
    line(info('This is you — the human. Your agents act on your behalf, and it lets you message'));
    line(info('people. (Internally this is your ours root; you just give it a name.)'));
    let defName = 'me';
    try { defName = userInfo().username || defName; } catch { /* keep fallback */ }
    const name = (ask(`  What name should others see?  ${c.gray(`[${defName}]`)}: `, defName) || defName).trim() || defName;
    let idActed = true;
    if (DRY) {
      line('  ' + c.dim(`[dry-run] would: ours-mcp create-root "${name}"`));
      line(ok(`Your human identity "${name}" is created.`));
      record({ key: 'identity', label: 'Human identity', state: 'installed', note: name });
    } else {
      // A freshly-started daemon may need a moment to bind its port before create-root can reach it.
      let reachable = daemonRunning();
      for (let i = 0; i < 6 && !reachable; i++) { sleepMs(400); reachable = daemonRunning(); }
      const r = reachable ? run('ours-mcp', ['create-root', name], { capture: true }) : { ok: false, out: '', err: 'daemon not running' };
      const outText = `${r.out} ${r.err}`;
      const existing = outText.match(/already exists \("([^"]+)"\)/);
      if (r.ok && existing) {
        line(ok(`You already have a human identity ("${existing[1]}") — keeping it.`));
        record({ key: 'identity', label: 'Human identity', state: 'current', note: existing[1] });
      } else if (r.ok) {
        line(ok(`Your human identity "${name}" is created.`));
        record({ key: 'identity', label: 'Human identity', state: 'installed', note: name });
      } else if (!reachable || /not running|not reachable/i.test(outText)) {
        line(warn("The daemon isn't reachable yet — couldn't create your human identity."));
        line(info(`Fix: run '${c.cyan('ours-mcp start')}', then '${c.cyan(`ours-mcp create-root "${name}"`)}'.`));
        record({ key: 'identity', label: 'Human identity', state: 'failed', note: 'daemon not reachable' });
      } else {
        const msg = (r.err || r.out || '').trim().split('\n')[0] || 'unknown error';
        line(warn(`Couldn't create your human identity: ${msg}`));
        line(info(`Retry any time: '${c.cyan(`ours-mcp create-root "${name}"`)}'.`));
        record({ key: 'identity', label: 'Human identity', state: 'failed', note: 'create-root failed' });
      }
    }
    cont(idActed);
  }

  // Step 2 harness installers (closures — share the helpers + `record` above). Alias / failure →
  // NEVER dead-end (owner edit #3): plain reason + manual path, always. Each returns whether it
  // ACTED (so a plain user-No skip shows no Continue pause).
  async function installClaude(h) {
    if (h.status !== 'ok') { manualClaude(h); record({ key: 'claude', label: 'Claude Code plugin', state: 'skipped', note: h.status === 'alias' ? 'installed as an alias' : 'not drivable' }); return true; }
    const go = yes('  Install the ours plugin into Claude Code?', true);
    if (!go) { line(info('skipped — re-run ours-install to add it.')); record({ key: 'claude', label: 'Claude Code plugin', state: 'skipped' }); return false; }
    const add = await act(`claude plugin marketplace add ${CLAUDE_MARKET}`, async () => run('claude', ['plugin', 'marketplace', 'add', CLAUDE_MARKET], { capture: true }));
    const inst = add.ok ? await act('claude plugin install ours@ours.network', async () => run('claude', ['plugin', 'install', 'ours@ours.network'], { capture: true })) : add;
    if (inst.ok) { line(ok(`Claude Code plugin installed — pointed at port ${chosenPort}. No problems.`)); line(info('(restart Claude Code to load it.)')); record({ key: 'claude', label: 'Claude Code plugin', state: 'installed', note: 'restart Claude Code' }); }
    else { failClaude(); record({ key: 'claude', label: 'Claude Code plugin', state: 'failed', note: 'marketplace/install step failed' }); }
    return true;
  }
  async function installCodex(h) {
    if (h.status !== 'ok') { manualCodex(h); record({ key: 'codex', label: 'Codex plugin + ours-codex', state: 'skipped', note: h.status === 'alias' ? 'installed as an alias' : 'not drivable' }); return true; }
    const go = yes('  Install the ours plugin into Codex?', true);
    if (!go) { line(info('skipped — re-run ours-install to add it.')); record({ key: 'codex', label: 'Codex plugin + ours-codex', state: 'skipped' }); return false; }
    const add = await act(`codex plugin marketplace add ${CODEX_MARKET}`, async () => run('codex', ['plugin', 'marketplace', 'add', CODEX_MARKET], { capture: true }));
    const inst = add.ok ? await act('codex plugin add ours@ours-codex-marketplace', async () => run('codex', ['plugin', 'add', 'ours@ours-codex-marketplace'], { capture: true })) : add;
    // Owner-mandated: choosing the Codex plugin ALSO installs the ours-codex live launcher, same step.
    const wrap = inst.ok ? await actSpin('installing the ours-codex live launcher…', `npm i -g ${spec('codex')} (provides ours-codex)`, () => runAsync(NPM, ['i', '-g', spec('codex')])) : inst;
    if (inst.ok && wrap.ok) {
      line(ok(`Codex plugin + ours-codex live launcher installed — pointed at port ${chosenPort}. No problems.`));
      // Plain-language: what ours-codex is and why you'd use it (background wake vs blocking).
      line(info('Two ways to run Codex now:'));
      line(info('  • plain "codex" — waits for mail in the foreground: it EITHER watches for new'));
      line(info('    messages OR takes your typing, one at a time — not both at once.'));
      line(info('  • "ours-codex" — our wrapper that turns on AUTO wake-up: it uses Codex\'s built-in'));
      line(info('    app server to watch for new mail in the BACKGROUND while you keep typing, so a'));
      line(info("    reply wakes it without interrupting you. Use 'ours-codex' for hands-off replies."));
      record({ key: 'codex', label: 'Codex plugin + ours-codex', state: 'installed', note: 'new Codex thread' });
    } else { failCodex(); record({ key: 'codex', label: 'Codex plugin + ours-codex', state: 'failed', note: 'marketplace/install step failed' }); }
    return true;
  }
  // Hermes: NOT a driven CLI. Its plugin install is `npm i -g @ours.network/hermes@<channel>` then
  // `ours-hermes-install`, which writes ~/.hermes/config.yaml (the ours MCP server) + the skills. No
  // marketplace/plugin-add, no alias-safety gate — nothing here calls the `hermes` binary. We pass
  // --skip-daemon because the unified installer already owns the daemon (Step 1, chosen port);
  // ours-hermes-install would otherwise re-ensure/restart it. Same never-dead-end contract as above.
  async function installHermes() {
    const go = yes('  Install the ours plugin into Hermes?', true);
    if (!go) { line(info('skipped — re-run ours-install to add it.')); record({ key: 'hermes', label: 'Hermes plugin', state: 'skipped' }); return false; }
    const npmOk = await actSpin(`installing ${spec('hermes')}…`, `npm i -g ${spec('hermes')} (provides ours-hermes-install)`, () => runAsync(NPM, ['i', '-g', spec('hermes')]));
    const inst = npmOk.ok
      ? await act('ours-hermes-install --skip-daemon (writes ~/.hermes: ours MCP server + skills)', async () => run('ours-hermes-install', ['--skip-daemon'], { capture: true }))
      : npmOk;
    if (inst.ok) {
      line(ok('Hermes plugin installed — the ours MCP server + skills are registered in ~/.hermes. No problems.'));
      line(info("(run '/reload-mcp' in Hermes to load the ours tools.)"));
      record({ key: 'hermes', label: 'Hermes plugin', state: 'installed', note: 'run /reload-mcp' });
    } else { failHermes(); record({ key: 'hermes', label: 'Hermes plugin', state: 'failed', note: 'npm/ours-hermes-install step failed' }); }
    return true;
  }

  // ============================================================================================
  // STEP 2 / 5 — harness plugins (Claude Code + Codex + Hermes). The installer drives the plugin
  // CLIs for Claude/Codex; Hermes installs via npm + ours-hermes-install (no CLI driving).
  // ============================================================================================
  line(heading('2/5 — harness plugins'));
  line(info('These teach Claude Code, Codex, and Hermes the ours skills, so you can just talk to your'));
  line(info("agent to message people and set things up. I'll install them for you — no commands to type."));
  for (const h of harnesses) {
    if (h.status === 'absent') continue; // nothing to offer; pre-flight already noted it
    line('');
    const acted = h.name === 'claude' ? await installClaude(h)
      : h.name === 'codex' ? await installCodex(h)
        : await installHermes(h);
    cont(acted);
  }

  // ============================================================================================
  // STEP 3 / 5 — ours-fleet. Appealing wording (owner edit #4); default YES.
  // ============================================================================================
  line(heading('3/5 — ours-fleet (your always-online agent team)'));
  line(info('This makes your harnesses PERSISTENT: Claude Code and Codex stop being just a terminal'));
  line(info('session and become always-online daemons that survive a reboot. Stand up your own team'));
  line(info('of always-online developers, combine harnesses, run several Claude Codes, and link them'));
  line(info('over Telegram so they talk to each other — and it all configures maximally easily.'));
  const goFleet = yes('  Install it?', true);
  if (goFleet) {
    // ours-fleet FOLLOWS the channel, like everything else here: it publishes its own
    // nightly dist-tag from adapt-toolkit/ours-fleet, and lib/logic.mjs maps it
    // accordingly. (This comment used to claim the opposite — that fleet had no nightly
    // tag and was pinned to @latest even under OURS_CHANNEL=nightly — which stopped
    // being true when the map gained its `fleet` entry. The code always followed the
    // map; only the comment was stale, which is the more dangerous of the two.)
    await actSpin(`installing ${spec('fleet')}…`, `npm i -g ${spec('fleet')}`, () => runAsync(NPM, ['i', '-g', spec('fleet')]));
    const init = await act('ours-fleet init (one-time host setup: units, dirs, linger)', async () => run('ours-fleet', ['init']));
    if (!init.ok) line(warn(`ours-fleet host setup didn't finish — retry '${c.cyan('ours-fleet init')}'.`));

    if (init.ok) {
      line(ok('ours-fleet ready — the core ours plugin discovers every option through `ours-fleet docs`. No problems.'));
    }
    record({
      key: 'fleet',
      label: 'ours-fleet',
      state: init.ok ? 'installed' : 'failed',
      version: globalVersion('@ours.network/fleet'),
      note: init.ok ? 'CLI + core-plugin discovery' : 'ours-fleet init failed',
    });
  } else {
    line(info('skipped cleanly — re-run ours-install any time to add it.'));
    record({ key: 'fleet', label: 'ours-fleet', state: 'skipped' });
  }
  cont(goFleet);

  // The broker the WHOLE deployment shares, whichever daemon a consumer talks to.
  const sharedBroker = () => resolveSharedBroker({
    chosenBroker,
    statusBroker: status0.broker,
    configBroker: readConfigObject().brokerUrl,
  });

  // Provision a daemon that belongs to ONE consumer: its own config file, its own
  // state directory, its own port, and — via core's OURS_SERVICE_NAME — its own boot
  // unit, so `install-service` cannot overwrite the shared daemon's. Returns the
  // endpoint + state dir to wire that consumer to, and whether it came up.
  async function provisionDedicatedDaemon({ instance, port, label }) {
    const { stateDir, configPath: cfgPath, serviceName } = dedicatedDaemonPaths(homedir(), instance);
    const env = { OURS_CONFIG: cfgPath, OURS_STATE_DIR: stateDir, OURS_SERVICE_NAME: serviceName };
    // The dedicated daemon has to exist as a package before it can be started; on a
    // fresh machine step 1 already installed it, but a re-run that skipped core has not.
    await actSpin(`ensuring ${spec('mcp')}…`, `npm i -g ${spec('mcp')}`, () => runAsync(NPM, ['i', '-g', spec('mcp')]));
    const desired = { port, stateDir, serviceName };
    const broker = sharedBroker();
    if (broker) desired.brokerUrl = broker;
    let existing = {};
    try { existing = JSON.parse(readFileSync(cfgPath, 'utf8')); } catch { /* absent or unreadable */ }
    const sameAlready = existing.port === port && existing.stateDir === stateDir && existing.serviceName === serviceName;
    if (sameAlready) {
      line(ok(`The ${label} daemon is already configured on port ${port} — no change.`));
      // Nothing to change AND it is already up: do not touch it. `install-service` STOPS
      // the daemon before rewriting the unit, so re-running it here would bounce a healthy
      // daemon for no reason.
      if (!DRY && run('ours-mcp', ['status'], { capture: true, env }).ok) {
        line(ok(`Dedicated ${label} daemon already running on port ${port} — left alone.`));
        return { endpoint: daemonEndpoint(port), stateDir, serviceName, configPath: cfgPath, running: true, port };
      }
    } else {
      await act(`write ${cfgPath} (dedicated ${label} daemon, port ${port}, state ${stateDir})`, async () => {
        atomicWriteConfig(cfgPath, mergeConfig(existing, desired));
        return { ok: true };
      });
    }
    const started = await act(`ours-mcp start (dedicated ${label} daemon, port ${port})`, async () => run('ours-mcp', ['start'], { env }));
    const svc = await act(`ours-mcp install-service (dedicated ${label} daemon, unit ours-${serviceName})`, async () => run('ours-mcp', ['install-service'], { env }));
    // Same recovery as the shared daemon: install-service STOPS the daemon before it
    // writes the unit, so a failure there leaves nothing listening on this port.
    let running = started.ok;
    if (!DRY && !svc.ok) {
      running = run('ours-mcp', ['status'], { capture: true, env }).ok;
      if (!running) {
        line(info(`the boot-service step stopped the ${label} daemon before it failed — restarting it.`));
        running = run('ours-mcp', ['start'], { env }).ok;
      }
      line(warn(`the ${label} daemon has no boot service — retry '${c.cyan(`OURS_CONFIG=${cfgPath} OURS_SERVICE_NAME=${serviceName} ours-mcp install-service`)}'.`));
    }
    if (running || DRY) line(ok(`Dedicated ${label} daemon ready on port ${port} (state ${stateDir}, unit ours-${serviceName}).`));
    else line(warn(`could not start the dedicated ${label} daemon — run '${c.cyan(`OURS_CONFIG=${cfgPath} ours-mcp start`)}'.`));
    return { endpoint: daemonEndpoint(port), stateDir, serviceName, configPath: cfgPath, running: running || DRY, port };
  }

  // Ask one consumer whether it uses the COMMON daemon or gets its own. Enter and
  // every non-interactive run answer "common" — the historical topology.
  const askDaemonMode = (what) => {
    line(info(`${what} can share the daemon from step 1, or run against its own isolated one.`));
    line(info('Sharing is right for almost everyone — press Enter. A dedicated daemon gets its own'));
    line(info('port, state directory and boot service, and does not see the shared daemon\'s identities.'));
    return yes(`  Give ${what} its OWN dedicated daemon?`, false) ? 'dedicated' : 'common';
  };

  // Give the Telegram connector the daemon it was assigned: that daemon's loopback
  // endpoint, the state directory that endpoint's API token belongs to, and — for a
  // pre-0.3.3 connector that still meets the daemon at a broker instead — that broker.
  // Idempotent: an unchanged selection writes nothing. Returns { changed, hadPrevious }
  // so the caller can warn about a service unit that froze an older selection.
  async function writeTgDaemonConfig({ endpoint, stateDir }) {
    const path = tgConfigPath(process.env, homedir());
    const desired = {
      daemonUrl: endpoint,
      daemonStateDir: stateDir,
      brokerUrl: sharedBroker(),
    };
    let existing = {};
    try { existing = JSON.parse(readFileSync(path, 'utf8')); } catch { /* absent or unreadable */ }
    const plan = planTgDaemonConfig(existing, desired);
    const hadPrevious = !!(plan.previous.daemonUrl || plan.previous.brokerUrl);
    if (!plan.changed) {
      line(ok(`Telegram connector already points at this daemon (${desired.daemonUrl}) — no change.`));
      return { changed: false, hadPrevious };
    }
    await act(`write ${path} (daemon ${desired.daemonUrl}, state ${stateDir})`, async () => {
      atomicWriteConfig(path, plan.text);
      return { ok: true };
    });
    line(ok(`Telegram connector configured to use this daemon (${desired.daemonUrl}).`));
    return { changed: true, hadPrevious };
  }

  // ============================================================================================
  // STEP 4 / 5 — Telegram connector. Install-only (no bot tokens here). Then: run as a service?
  // ============================================================================================
  line(heading('4/5 — Telegram connector'));
  line(info('This bridges a Telegram bot to your Ours node, so you can talk to your agent from'));
  line(info("Telegram. (You'll set up the actual bot later, with your agent — not here.)"));
  const goTg = yes('  Install it?', false);
  if (goTg) {
    await actSpin(`installing ${spec('tg-connector')}…`, `npm i -g ${spec('tg-connector')}`, () => runAsync(NPM, ['i', '-g', spec('tg-connector')]));
    // WHICH daemon — asked independently of every other consumer, and answered
    // "common" by Enter / non-interactive so the historical topology is the default.
    line('');
    const tgMode = askDaemonMode('the Telegram connector');
    let tgDaemon = { endpoint: daemonEndpoint(chosenPort), stateDir: daemonStateDir(), port: chosenPort, mode: 'common' };
    if (tgMode === 'dedicated') {
      const instance = DEDICATED_INSTANCES.telegram;
      const suggested = suggestPort(chosenPort + 1, (p) => claimedPorts.includes(p) || portTakenSync(p));
      const port = askDaemonPort('Which local port should the Telegram daemon use?', suggested);
      claimPort(port, 'the dedicated Telegram daemon');
      const provisioned = await provisionDedicatedDaemon({ instance, port, label: 'Telegram' });
      tgDaemon = { ...provisioned, mode: 'dedicated' };
    } else {
      line(ok(`Telegram will use the shared daemon on port ${chosenPort}.`));
    }
    // POINT IT AT THAT DAEMON — BEFORE it is started or installed as a service.
    // The connector never inherits ~/.ours/config.json (its SDK reports configPath:
    // null unless told otherwise), and `install-service` bakes whatever it resolves
    // into the unit as environment variables that outrank the file from then on. So
    // the daemon's identity has to be in its config BEFORE either happens. See
    // planTgDaemonConfig for why all three keys are written.
    const tgConfigured = await writeTgDaemonConfig(tgDaemon);
    const where = tgDaemon.mode === 'dedicated' ? `its own daemon on port ${tgDaemon.port}` : `the shared daemon on port ${tgDaemon.port}`;
    const asService = yes('  Keep it running in the background so it starts automatically on boot?', true);
    if (asService) {
      const svc = await act('ours-tg-connector install-service (starts on boot)', async () => run('ours-tg-connector', ['install-service']));
      if (svc.ok) line(ok(`Telegram connector installed and running as a service (starts on boot), pointed at ${where}. No problems.`));
      else line(warn(`connector installed, but the service didn't start — retry '${c.cyan('ours-tg-connector install-service')}'.`));
      record({ key: 'telegram', label: 'Telegram connector', state: 'installed', version: globalVersion('@ours.network/tg-connector'), note: `service (boot) · ${tgDaemon.mode} daemon ${tgDaemon.port}` });
    } else {
      line(ok(`Telegram connector installed, pointed at ${where}. Start it any time with '${c.cyan('ours-tg-connector start')}'. No problems.`));
      // A connector already installed as a service froze its OLD daemon selection into
      // the unit's environment, which outranks the file we just wrote. Config alone
      // cannot repair that — say so plainly rather than let it look fixed.
      if (tgConfigured.changed && tgConfigured.hadPrevious) {
        line(warn(`if you previously ran '${c.cyan('ours-tg-connector install-service')}', re-run it — the old service froze the previous daemon selection in its unit.`));
      }
      record({ key: 'telegram', label: 'Telegram connector', state: 'installed', version: globalVersion('@ours.network/tg-connector'), note: `start on demand · ${tgDaemon.mode} daemon ${tgDaemon.port}` });
    }
  } else {
    line(info('skipped cleanly.'));
    record({ key: 'telegram', label: 'Telegram connector', state: 'skipped' });
  }
  cont(goTg);

  // ============================================================================================
  // STEP 5 / 5 — Rooms (ours-cowork). Two independent things get configured here.
  //
  // ITS OWN SURFACE — the deployment broker, its private state directory, and its loopback
  // console/REST port. Those it has always had.
  //
  // WHICH DAEMON — ours-cowork used to host its own, always. It now supports an EXTERNAL ours
  // daemon (cowork PR #9), so Rooms answers the same common-vs-dedicated question the Telegram
  // connector does, plus a third state the connector does not have: EMBEDDED, cowork's own.
  // Contract (see logic.mjs): the `daemon` block is optional; absent means embedded; external is
  // { mode:'external', endpoint, stateDir } and REQUIRES both halves, because cowork holds no
  // token and its SDK reads <stateDir>/daemon-token.
  //
  // Boot is FAIL-CLOSED on an unreachable endpoint, a non-ours daemon, or a mismatched state
  // directory — there is no embedded fallback. So an install that is ALREADY running embedded is
  // never migrated behind the user's back: non-interactively it is left exactly as it is, and
  // interactively the question is asked plainly before anything is written.
  // ============================================================================================
  line(heading('5/5 — Rooms (ours-cowork)'));
  line(info('Durable mission rooms: a room keeps its own ordered history, and people and agents'));
  line(info('join it as seats. It serves a local web console, and reaches everyone through the'));
  line(info('same broker as the rest of your install.'));
  const goRooms = yes('  Install it?', false);
  if (goRooms) {
    await actSpin(`installing ${spec('cowork')}…`, `npm i -g ${spec('cowork')}`, () => runAsync(NPM, ['i', '-g', spec('cowork')]));
    const roomsStateDir = join(homedir(), '.ours-cowork');
    const cfgPath = coworkConfigPath(process.env, homedir());
    let existingRooms = {};
    try { existingRooms = JSON.parse(readFileSync(cfgPath, 'utf8')); } catch { /* absent or unreadable */ }
    const restDefault = Number.isInteger(existingRooms.rest?.port) ? existingRooms.rest.port : COWORK_DEFAULT_PORT;
    line('');
    line(info('Rooms serves a console on a loopback port — 127.0.0.1 only, never exposed.'));
    // COWORK_DEFAULT_PORT is in RESERVED_PORTS (so no ours daemon can be handed it),
    // so validate this one against the daemon ports only.
    const roomsPort = (() => {
      let candidate = restDefault;
      for (let attempt = 0; attempt < 3; attempt++) {
        const raw = ask(`  Which local port should the Rooms console use?  ${c.gray(`[Enter for ${candidate}]`)}: `, String(candidate));
        const v = validateDaemonPort(raw, {
          fallback: candidate, isTaken: (p) => (p === restDefault ? false : portTakenSync(p)),
          taken: claimedPorts, reserved: [],
        });
        if (v.ok) return v.port;
        line(warn(`${v.reason}.`));
        if (!interactive) break;
        candidate = suggestPort(v.port + 1, (p) => claimedPorts.includes(p) || portTakenSync(p));
        line(info(`Suggesting ${candidate} instead.`));
      }
      return candidate;
    })();
    claimPort(roomsPort, 'the Rooms console');

    // WHICH DAEMON. `undefined` means "leave whatever is there alone" — the answer for an
    // existing embedded install nobody asked to migrate.
    const wasEmbedded = coworkDaemonMode(existingRooms) === 'embedded';
    const hadConfig = existsSync(cfgPath);
    // Ask the BUILD, not the channel: this runs after the install above, so the version
    // read here is the one actually on the machine.
    const coworkVersion = globalVersion('@ours.network/cowork');
    const externalSupported = coworkSupportsExternalDaemon(coworkVersion);
    let roomsDaemon;
    let roomsDaemonLabel;
    if (!externalSupported) {
      // The build we just installed predates cowork's external-daemon mode. Its config
      // is a strict document and its boot fails closed, so writing a selection it cannot
      // honour would break Rooms rather than degrade it.
      line(info(`This Rooms build${coworkVersion ? ` (${coworkVersion})` : ''} hosts its own daemon; pointing it at the shared`));
      line(info(`one needs ${COWORK_EXTERNAL_MIN_VERSION} or newer. Re-run with ${c.cyan('OURS_CHANNEL=nightly')} to get it.`));
      roomsDaemonLabel = 'embedded';
    } else if (hadConfig && wasEmbedded && !interactive) {
      // Fail-closed boot makes this migration a real risk; never do it unasked.
      line(info('Rooms already runs its own embedded daemon — leaving that alone.'));
      line(info(`To point it at this install's daemon, re-run ${c.cyan('ours-install')} in a terminal.`));
      roomsDaemonLabel = 'embedded (unchanged)';
    } else {
      line('');
      const roomsMode = askDaemonMode('Rooms');
      if (roomsMode === 'dedicated') {
        const instance = DEDICATED_INSTANCES.rooms;
        const suggested = suggestPort(chosenPort + 1, (p) => claimedPorts.includes(p) || portTakenSync(p));
        const port = askDaemonPort('Which local port should the Rooms daemon use?', suggested);
        claimPort(port, 'the dedicated Rooms daemon');
        const provisioned = await provisionDedicatedDaemon({ instance, port, label: 'Rooms' });
        roomsDaemon = { endpoint: provisioned.endpoint, stateDir: provisioned.stateDir };
        roomsDaemonLabel = `dedicated daemon ${port}`;
      } else {
        roomsDaemon = { endpoint: daemonEndpoint(chosenPort), stateDir: daemonStateDir() };
        roomsDaemonLabel = `common daemon ${chosenPort}`;
        line(ok(`Rooms will use the shared daemon on port ${chosenPort}.`));
      }
    }

    const roomsPlan = planCoworkConfig(existingRooms, {
      brokerUrl: sharedBroker(),
      stateDir: roomsStateDir,
      restPort: roomsPort,
      daemon: roomsDaemon,
    });
    if (roomsPlan.error) {
      // Only reachable if a daemon selection lost half of itself; a half-written block
      // would fail closed at cowork's boot, so refuse rather than write it.
      line(warn(`not changing the Rooms daemon selection — ${roomsPlan.error}.`));
    } else if (roomsPlan.changed) {
      await act(`write ${cfgPath} (console port ${roomsPort}, state ${roomsStateDir}${roomsDaemon ? `, daemon ${roomsDaemon.endpoint}` : ''})`, async () => {
        atomicWriteConfig(cfgPath, roomsPlan.text);
        return { ok: true };
      });
      if (roomsDaemon) line(ok(`Rooms configured to use ${roomsDaemonLabel} (${roomsDaemon.endpoint}, state ${roomsDaemon.stateDir}).`));
    } else {
      line(ok(`Rooms is already configured for this deployment (console port ${roomsPort}) — no change.`));
    }
    const svc = await act('ours-cowork install-service (starts on boot)', async () => run('ours-cowork', ['install-service']));
    if (svc.ok) {
      line(ok(`Rooms ready — console at ${c.cyan(`http://127.0.0.1:${roomsPort}/`)}, sharing your broker. No problems.`));
    } else {
      line(warn(`Rooms installed, but its service didn't start — retry '${c.cyan('ours-cowork install-service')}'.`));
      line(info(`You can also run it in the foreground: '${c.cyan('ours-cowork web')}'.`));
    }
    record({
      key: 'rooms',
      label: 'Rooms (ours-cowork)',
      state: svc.ok ? 'installed' : 'failed',
      version: coworkVersion,
      note: svc.ok ? `console ${roomsPort} · ${roomsDaemonLabel}` : 'ours-cowork install-service failed',
    });
  } else {
    line(info('skipped cleanly — re-run ours-install any time to add it.'));
    record({ key: 'rooms', label: 'Rooms (ours-cowork)', state: 'skipped' });
  }
  cont(goRooms);

  // Last guard on the whole topology: no two daemons in this install may share a port.
  // Each answer was validated as it was given, but only the finished plan proves the set.
  const portPlan = planPorts(topology);
  if (!portPlan.ok) {
    for (const d of portPlan.duplicates) {
      line(warn(`port ${d.port} ended up claimed by both ${d.labels[0]} and ${d.labels[1]} — one of them will fail to bind.`));
    }
  }

  return endScreen({ ttyFd, summary, chosenPort, chosenBroker });
}

// --- never-dead-end messaging (owner edit #3) --------------------------------------------------
function manualClaude(h) {
  if (h.status === 'alias') {
    line(warn('Heads-up: on your machine, "claude" is installed as an alias, not the real command,'));
    line(info('so I can\'t drive it safely. To fix it: run  ' + c.cyan('type claude') + '  , remove/rename that'));
    line(info('alias in your shell config, open a new terminal, and re-run ours-install.'));
  } else {
    line(warn('I couldn\'t safely drive the "claude" command on this machine.'));
  }
  line(info('You can still install the plugin yourself — inside Claude Code, run these two:'));
  line('    ' + c.cyan(`/plugin marketplace add ${CLAUDE_MARKET}`));
  line('    ' + c.cyan('/plugin install ours'));
}
function failClaude() {
  line(warn('Couldn\'t install the Claude Code plugin automatically (network or plugin cache).'));
  line(info('Install it by hand — inside Claude Code, run these two, then re-run ours-install:'));
  line('    ' + c.cyan(`/plugin marketplace add ${CLAUDE_MARKET}`));
  line('    ' + c.cyan('/plugin install ours'));
  line(info('Your daemon and other steps are intact. Continuing.'));
}
function manualCodex(h) {
  if (h.status === 'alias') {
    line(warn('Heads-up: on your machine, "codex" is installed as an alias, not the real command,'));
    line(info('so I can\'t drive it safely. To fix it: run  ' + c.cyan('type codex') + '  , remove/rename that'));
    line(info('alias in your shell config, open a new terminal, and re-run ours-install.'));
  } else {
    line(warn('I couldn\'t safely drive the "codex" command on this machine.'));
  }
  line(info('You can still install it yourself — run these three in your terminal:'));
  line('    ' + c.cyan(`codex plugin marketplace add ${CODEX_MARKET}`));
  line('    ' + c.cyan('codex plugin add ours@ours-codex-marketplace'));
  line('    ' + c.cyan('npm i -g @ours.network/codex') + c.gray('   (adds the ours-codex live launcher)'));
}
function failCodex() {
  line(warn('Couldn\'t install the Codex plugin automatically (network or plugin cache).'));
  line(info('Install it by hand — run these three, then re-run ours-install:'));
  line('    ' + c.cyan(`codex plugin marketplace add ${CODEX_MARKET}`));
  line('    ' + c.cyan('codex plugin add ours@ours-codex-marketplace'));
  line('    ' + c.cyan('npm i -g @ours.network/codex'));
  line(info('Your daemon and other steps are intact. Continuing.'));
}
function failHermes() {
  line(warn('Couldn\'t install the Hermes plugin automatically (network or npm).'));
  line(info('Install it by hand — run these two, then run /reload-mcp in Hermes:'));
  line('    ' + c.cyan('npm i -g @ours.network/hermes'));
  line('    ' + c.cyan('ours-hermes-install'));
  line(info('Your daemon and other steps are intact. Continuing.'));
}
// --- final summary + copy-paste hand-off -------------------------------------------------------
function endScreen({ ttyFd, summary, chosenPort, chosenBroker }) {
  line('');
  line('  ' + c.cyan('═'.repeat(64)));
  line('  ' + c.bold('ours.network — install complete'));
  line('  ' + c.gray(`Daemon port: ${chosenPort}   •   Broker: ${chosenBroker ? 'custom' : 'standard'}`));
  line('  ' + c.cyan('═'.repeat(64)));
  for (const row of summary) {
    const m = row.state === 'failed' ? c.red('✗') : row.state === 'skipped' ? c.gray('·') : c.green('✓');
    const label = row.label.padEnd(26);
    const ver = (row.version ? `v${row.version}` : '').padEnd(9);
    const state = (row.state === 'installed' || row.state === 'current') ? (row.note || 'ready')
      : row.state === 'skipped' ? c.gray('skipped' + (row.note ? ` (${row.note})` : ''))
        : c.red('needs attention' + (row.note ? ` — ${row.note}` : ''));
    line(`  ${m} ${label}${ver}${state}`);
  }
  const anyFail = summary.some((r) => r.state === 'failed');
  line('');
  line(anyFail
    ? '  ' + c.yellow('Some pieces need a hand — see the notes above; re-run ours-install after fixing.')
    : '  ' + c.green('Everything installed cleanly. No problems.'));

  // The literal copy-paste hand-off — skipped/failed components drop out. The human identity is
  // normally created in-install, so its step appears ONLY as a fallback when that didn't succeed.
  const has = (k) => summary.some((r) => r.key === k && (r.state === 'installed' || r.state === 'current'));
  if (has('core')) {
    const identityDone = has('identity');
    const { text, empty } = buildHandoffPrompt({
      identity: !identityDone, fleet: has('fleet'), telegram: has('telegram'), rooms: has('rooms'),
    });
    if (empty) {
      // Nothing left to finish (identity created in-install, no fleet/Telegram). Don't show an empty box.
      line('');
      line('  ' + c.green("You're all set — open Claude Code or Codex and just start talking to your agent."));
    } else {
      line('');
      line('  ' + c.gray('─'.repeat(64)));
      line('  ' + c.bold('ONE LAST STEP') + ' — copy the prompt below and paste it into Claude Code');
      line('  (or Codex). Your agent walks you through the rest, conversationally.');
      line('  ' + c.gray('─'.repeat(64)));
      line('');
      line(box(text.split('\n'), 'paste this into your agent'));
      copyToClipboard(text);
    }
  }
  line('');
  line('  ' + c.gray('Re-run  ') + c.cyan('ours-install') + c.gray('  any time to add a skipped piece or update.'));
  line('  ' + c.cyan('═'.repeat(64)));
  finish(ttyFd);
  // Exit CLEANLY right after the summary — never leave the user at a hung installer (the tty is
  // closed above; a lingering clipboard child or signal listener must not keep us alive).
  process.exit(0);
}

// Best-effort clipboard copy (pbcopy/wl-copy/xclip/clip). Silent when unsupported. A hard timeout
// keeps a lingering/blocking clipboard helper (e.g. xclip holding the selection) from ever stalling
// the exit.
function copyToClipboard(text) {
  if (DRY) return;
  const tools = [['pbcopy', []], ['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['clip.exe', []]];
  for (const [bin, args] of tools) {
    try {
      const r = spawnSync(bin, args, { input: text, timeout: 2000 });
      if (!r.error && !r.timedOut && (r.status === 0 || r.status == null)) { line('  ' + c.gray('(copied to your clipboard.)')); return; }
    } catch { /* try the next one */ }
  }
}

function finish(ttyFd) {
  if (ttyFd != null) { try { closeSync(ttyFd); } catch { /* ignore */ } }
}

main().catch((e) => {
  // A Ctrl+C thrown out of a blocked prompt read → the clean cancel path (exit 130).
  if (isCancel(e)) { if (cancelHandler) return cancelHandler(); process.exit(130); }
  // Otherwise: degrade, don't crash — one honest line, non-zero exit.
  say(`unexpected error: ${String(e)}`);
  process.exitCode = 1;
});
