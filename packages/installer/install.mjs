#!/usr/bin/env node
// ours.network — the Node installer (the real UX behind install.sh's thin bootstrap).
//
// It installs + starts the ours daemon (your local mesh node), optionally as a persistent
// service, lets you set the broker + HTTP port the daemon uses, then multi-selects which agent
// harnesses to wire up and runs each one's plugin installer. Every step explains WHAT it does and
// WHY, in plain language, with tasteful colour that degrades under NO_COLOR / no-tty.
//
// Interactive prompts are drawn on /dev/tty so `curl … | bash` still works. With no controlling
// terminal (true headless / CI) it falls back to environment variables and makes safe do-nothing
// choices rather than blocking — see the env overrides in install.sh's header.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join, dirname } from 'node:path';
import { banner, section, heading, ok, step, info, warn, c, box, withSpinner, openTty, makeWriter, closeSync } from './lib/ui.mjs';
import { askLine, askYesNo, checkboxSelect } from './lib/prompt.mjs';
import {
  canonHarnesses, suggestPort, parsePort, validateBroker, mergeConfig, parseVersion, parseStatus,
  DEFAULT_BROKER, DEFAULT_PORT, RESERVED_PORTS,
} from './lib/logic.mjs';

const NPM = process.env.OURS_NPM || 'npm';
// All narrative output goes through `sink` so the wizard can redirect it to the tty's alternate
// screen and hand it back to stdout for the final (persistent) summary.
let sink = (s) => process.stdout.write(s);
const say = (s) => sink(`ours: ${s}\n`);
const line = (s = '') => sink(`${s}\n`);

// --- step-by-step wizard (alternate screen buffer) ----------------------------------------------
// On a real interactive terminal the installer behaves like an app installer: ONE step per
// screen on the ANSI alternate buffer — a finished step is REPLACED by the next, never scrolled
// past — with a "Step k of N" indicator. Piped / no-tty / TERM=dumb / NO_COLOR / OURS_ASSUME_YES
// runs keep the plain linear log (what tests and logs see). The main buffer is restored BEFORE
// the closing summary + next-steps panel, so they stay visible after the wizard closes.
const wizard = { active: false, write: null, step: 0, total: 0 };
function wizardEnter(write, total) {
  wizard.active = true; wizard.write = write; wizard.total = total;
  write('\x1b[?1049h\x1b[2J\x1b[H');
  sink = write;
}
function wizardLeave() {
  if (!wizard.active) return;
  wizard.active = false;
  wizard.write('\x1b[?1049l');
  sink = (s) => process.stdout.write(s);
}
function wizardScreen(title) {
  wizard.step++;
  wizard.write('\x1b[2J\x1b[H');
  const prog = `Step ${wizard.step} of ${wizard.total}`;
  const pad = ' '.repeat(Math.max(2, 64 - 2 - 'ours.network'.length - prog.length));
  line('');
  line('  ' + c.bold(c.cyan('ours')) + c.gray('.network') + pad + c.gray(prog));
  line('');
  line('  ' + c.cyan('──') + ' ' + c.bold(title) + ' ' + c.gray('─'.repeat(Math.max(2, 64 - title.length - 7))));
  line('');
}

// --- external command helpers (never throw; the installer degrades, it doesn't crash) ----------
function run(bin, args, { capture = false } = {}) {
  const r = spawnSync(bin, args, {
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  return { code: r.status ?? (r.error ? -1 : 0), out: r.stdout || '', err: r.stderr || '', ok: !r.error && r.status === 0 };
}
// Async twin of run() for the long npm steps, so a spinner can animate while they work. Output is
// captured (npm's own noise stays off the pretty run) and surfaced by the caller on failure.
function runAsync(bin, args) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { resolve({ code: -1, out: '', err: '', ok: false }); return; }
    let out = '';
    let errOut = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { errOut += d; });
    child.on('error', () => resolve({ code: -1, out, err: errOut, ok: false }));
    child.on('close', (code) => resolve({ code: code ?? -1, out, err: errOut, ok: code === 0 }));
  });
}
const daemonVersionLine = () => (run('ours-mcp', ['--version'], { capture: true }).out.split('\n')[0] || '').trim();
const daemonStatusText = () => run('ours-mcp', ['status'], { capture: true }).out;
const daemonRunning = () => run('ours-mcp', ['status'], { capture: true }).code === 0;

// --- config file (fixed home location, independent of stateDir; mirrors core/config.ts) --------
function configPath() {
  return process.env.OURS_CONFIG || join(homedir(), '.ours', 'config.json');
}
function readConfigObject() {
  try { return JSON.parse(readFileSync(configPath(), 'utf8')); } catch { return {}; }
}
function writeConfigPatch(patch) {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, mergeConfig(readConfigObject(), patch));
  return p;
}

// Is `port` already bound by some process? net.Server#listen is async, so we probe in a throwaway
// child node process and read its exit code — a clean synchronous answer. EADDRINUSE ⇒ taken.
function portTakenSync(port) {
  const script = `const net=require('net');const s=net.createServer();s.once('error',e=>{process.exit(e.code==='EADDRINUSE'?3:0)});s.listen(${port},'127.0.0.1',()=>{s.close(()=>process.exit(0))});`;
  const r = spawnSync(process.execPath, ['-e', script], { timeout: 3000 });
  return r.status === 3;
}

// ===============================================================================================
async function main() {
  const ttyFd = openTty();
  const interactive = ttyFd != null && !process.env.OURS_ASSUME_YES;
  const write = makeWriter(ttyFd);
  const useWizard = interactive && !process.env.NO_COLOR && (process.env.TERM || '') !== 'dumb';

  // Probe up front (cheap) so the wizard knows its step count before the first screen.
  const versionBefore = daemonVersionLine();
  const firstInstall = !versionBefore; // absent binary / failed version probe = not installed yet

  if (useWizard) {
    // A killed wizard must never leave the terminal stranded on the alternate screen.
    process.on('SIGINT', () => { wizardLeave(); process.exit(130); });
    process.on('SIGTERM', () => { wizardLeave(); process.exit(143); });
    wizardEnter(write, firstInstall ? 5 : 4);
    wizardScreen('welcome');
  }
  line(banner());
  say('This sets up your local ours node and connects the AI agents you choose.');
  line('  ' + c.dim('Takes about a minute — you approve each step, and you can re-run any time.'));

  // --- 1) daemon: consent-gated first install; ensure @latest + restart on change otherwise ----
  if (!useWizard) line(section(1, 'ours daemon'));
  line(info('The daemon is your local ours node — it keeps your connection to the mesh alive.'));
  if (firstInstall) {
    // Never install the shared daemon silently: describe what it is, then ask. The safe default
    // is NOT installing — a headless/piped run with no tty only proceeds with an explicit
    // OURS_ASSUME_YES=1 (the same convention as install.sh's other env overrides).
    line('');
    line(info('ours.network needs to install one shared background process on this computer.'));
    line(info("It manages your agents' identities, stores their keys, sends and accepts invites,"));
    line(info('encrypts and decrypts your messages, and gives your agents access to all of this'));
    line(info('through the MCP server protocol.'));
    const consent = process.env.OURS_ASSUME_YES
      ? true
      : askYesNo(write, ttyFd, '  Install it now?', false);
    if (!consent) {
      wizardLeave();
      if (ttyFd == null) say('no terminal to ask for consent and OURS_ASSUME_YES=1 not set.');
      say('okay — nothing was installed. Re-run this installer any time to set up ours.');
      finish(ttyFd);
      return;
    }
  }

  // First install: ask for the person's name BEFORE the install work (its own wizard step; same
  // prompt order in linear mode so both modes read one key script). The root identity itself is
  // created right after the daemon is up.
  let rootName;
  if (firstInstall) {
    if (useWizard) wizardScreen('your identity');
    line(info('Your agents act for a person — you. This creates your ours identity (their root).'));
    let defaultName = 'me';
    try { defaultName = userInfo().username || defaultName; } catch { /* keep the fallback */ }
    rootName = askLine(write, ttyFd, `  Your name ${c.gray(`[${defaultName}]`)}: `, defaultName).trim() || defaultName;
  }

  if (useWizard) wizardScreen('install & settings');
  const before = parseVersion(versionBefore);
  const ensured = await withSpinner('ensuring @ours.network/mcp@latest…', () => runAsync(NPM, ['i', '-g', '@ours.network/mcp@latest']));
  if (!ensured.ok) line(warn('npm install of @ours.network/mcp did not finish cleanly — continuing with what is there.'));
  const after = parseVersion(daemonVersionLine());
  if (!daemonRunning()) {
    line(step('starting the daemon…'));
    if (!run('ours-mcp', ['start']).ok) say("could not auto-start; run 'ours-mcp start' if the tools error.");
    else line(ok('daemon started.'));
  } else if (before && before !== after) {
    line(step(`daemon upgraded (v${before} → v${after}) — restarting…`));
    if (!run('ours-mcp', ['restart']).ok) run('ours-mcp', ['start']);
    line(ok(`daemon on v${after}.`));
  } else {
    line(ok(`daemon already current${after ? ` (v${after})` : ''}.`));
  }

  // First install only: create THE root human identity right now, deterministically — no agent
  // should have to discover and decide this later. `ours-mcp create-root` is a quiet no-op if a
  // root somehow already exists; a failure degrades (the agent can still create it in-session).
  let rootIdentity;
  if (firstInstall) {
    const created = run('ours-mcp', ['create-root', rootName], { capture: true });
    if (created.ok) { rootIdentity = rootName; line(ok(`your identity "${rootName}" is created.`)); }
    else say(`could not create your identity now (non-fatal) — ask your agent to create it later.`);
  }

  // Read the daemon's RESOLVED broker + port so we prompt with real values, not a hardcoded guess.
  const status = parseStatus(daemonStatusText());
  const brokerCurrent = status.broker || DEFAULT_BROKER;
  const portCurrent = status.port || DEFAULT_PORT;

  // --- 2) persistent service (optional) --------------------------------------------------------
  if (!useWizard) line(section(2, 'persistent service'));
  else line('');
  line(info('A service means ours restarts on its own after a reboot, so you stay reachable.'));
  const svcEnv = (process.env.OURS_SERVICE || '').toLowerCase();
  const wantSvc = svcEnv ? svcEnv === 'yes' || svcEnv === 'y' || svcEnv === '1'
    : askYesNo(write, ttyFd, '  Install the ours daemon as a persistent service?', false);
  if (wantSvc) {
    line(step('installing the persistent service…'));
    if (run('ours-mcp', ['install-service']).ok) line(ok('service installed (survives reboot).'));
    else say("service install failed (non-fatal) — retry 'ours-mcp install-service' later.");
  } else {
    line(info("skipped — start on demand with 'ours-mcp start'."));
  }

  // --- 3) broker address -----------------------------------------------------------------------
  if (!useWizard) line(section(3, 'broker address'));
  else line('');
  line(info('The broker is the public relay your node dials to reach peers. Keep the default'));
  line(info('unless you run your own broker.'));
  const brokerEnv = process.env.OURS_BROKER || process.env.OURS_BROKER_URL || '';
  let brokerAnswer = brokerEnv
    || askLine(write, ttyFd, `  Broker address ${c.gray(`[${brokerCurrent}]`)}: `, brokerCurrent);
  let brokerToWrite;
  if (brokerAnswer && brokerAnswer !== brokerCurrent) {
    const v = validateBroker(brokerAnswer);
    if (!v.ok) { line(warn(`"${brokerAnswer}" doesn't look like a ws:// URL — keeping ${brokerCurrent}.`)); }
    else { brokerToWrite = v.value; line(ok(`broker set to ${brokerToWrite}.`)); }
  } else {
    line(ok(`keeping ${brokerCurrent}.`));
  }

  // --- 4) HTTP port ----------------------------------------------------------------------------
  if (!useWizard) line(section(4, 'HTTP port'));
  else line('');
  line(info('The local port the daemon listens on for your agent (default ' + DEFAULT_PORT + ').'));
  const portEnv = process.env.OURS_PORT || '';
  const portRaw = portEnv || askLine(write, ttyFd, `  HTTP port ${c.gray(`[${portCurrent}]`)}: `, String(portCurrent));
  const { ok: portOk, port: portWanted } = parsePort(portRaw, portCurrent);
  if (!portOk) line(warn(`"${portRaw}" isn't a valid port — keeping ${portCurrent}.`));
  let portToWrite;
  if (portOk && portWanted !== portCurrent) {
    // Only probe when the user asks for a DIFFERENT port than the one the daemon already holds
    // (probing the daemon's own port would always read as "taken"). Never hand out 3051.
    const finalPort = suggestPort(portWanted, portTakenSync);
    if (finalPort !== portWanted) {
      const reason = RESERVED_PORTS.includes(portWanted) ? 'reserved (Telegram connector)' : 'already in use';
      line(warn(`port ${portWanted} is ${reason} — using ${finalPort} instead.`));
    }
    portToWrite = finalPort;
    line(ok(`port set to ${portToWrite}.`));
  } else if (portOk) {
    line(ok(`keeping ${portCurrent}.`));
  }

  // Apply broker/port to config.json + restart the daemon so it takes effect (only if changed).
  if (brokerToWrite !== undefined || portToWrite !== undefined) {
    const patch = {};
    if (brokerToWrite !== undefined) patch.brokerUrl = brokerToWrite;
    if (portToWrite !== undefined) patch.port = portToWrite;
    const p = writeConfigPatch(patch);
    line(step(`applying config (${p}) and restarting the daemon…`));
    if (!run('ours-mcp', ['restart']).ok) run('ours-mcp', ['start']);
  }

  // --- 5) select harnesses ---------------------------------------------------------------------
  if (useWizard) wizardScreen('agent harnesses');
  else line(section(5, 'agent harnesses'));
  line(info('A harness is your AI agent\'s app. The plugin connects it to ours; the bundled skill'));
  line(info('teaches your agent to send, receive, and monitor messages.'));
  const HARNESS_SPECS = [
    { name: 'claude-code', label: 'Claude Code' },
    { name: 'codex', label: 'Codex' },
    { name: 'hermes', label: 'Hermes' },
  ];
  let selected;
  if (process.env.OURS_HARNESSES != null) {
    const { names, unknown } = canonHarnesses(process.env.OURS_HARNESSES);
    for (const u of unknown) say(`  (ignoring unknown harness '${u}')`);
    selected = names;
  } else if (ttyFd != null) {
    selected = checkboxSelect(write, ttyFd, HARNESS_SPECS, {
      title: `Choose harnesses to set up — ${c.bold('↑/↓')} move, ${c.bold('Space')} toggle, ${c.bold('Enter')} confirm (a=all, n=none)`,
    });
  } else {
    say('no terminal and no OURS_HARNESSES set — skipping harness setup (daemon is installed).');
    selected = [];
  }

  if (selected.length === 0) {
    wizardLeave(); // the closing summary must persist on the MAIN screen
    line(heading('Done'));
    say('Daemon is set up. No harness selected — re-run any time, or install one directly:');
    say('  npm i -g @ours.network/{hermes,codex} && ours-<harness>-install');
    if (firstInstall) { line(''); line(nextStepsPanel(rootIdentity)); }
    finish(ttyFd);
    return;
  }
  say(`setting up: ${selected.join(' ')}`);

  // --- 6) run each selected harness's installer ------------------------------------------------
  const installed = [];
  const failed = [];
  for (const h of selected) {
    if (h === 'claude-code') {
      line(heading('claude-code'));
      say("Claude Code installs its plugin from its in-app marketplace — the installer can't do");
      say('this part for you. Inside your Claude Code session, run these TWO commands:');
      line('');
      line('    /plugin marketplace add adapt-toolkit/ours-claude-marketplace');
      line('    /plugin install ours');
      line('');
      say('(The daemon this installer set up is what that plugin talks to.)');
      if (interactive) askLine(write, ttyFd, '  Run the 2 commands inside Claude Code, then press Enter to continue… ', '');
      installed.push('claude-code');
    } else {
      // hermes | codex — @latest bypasses a stale global so a re-run upgrades the plugin (and its
      // bundled skill); the bin then does its own daemon-ensure + legacy cleanup.
      line(heading(h));
      const plugin = await withSpinner(`installing @ours.network/${h}@latest…`, () => runAsync(NPM, ['i', '-g', `@ours.network/${h}@latest`]));
      if (!plugin.ok) line(warn(`npm install of @ours.network/${h} did not finish cleanly — trying its installer anyway.`));
      line(step(`running ours-${h}-install`));
      if (run(`ours-${h}-install`, []).ok) { line(ok(`${h} installed and working.`)); installed.push(h); }
      else { line(warn(`${h} setup failed (continuing).`)); failed.push(h); }
    }
  }

  // --- 7) end screen — brief "how to use" + versions -------------------------------------------
  wizardLeave(); // the closing summary must persist on the MAIN screen
  line(heading('Done ✦ welcome to the mesh'));
  say(`ours daemon: ${run('ours-mcp', ['status'], { capture: true }).ok ? 'running' : 'installed'}`);
  say('versions:');
  say(`  daemon: ${daemonVersionLine() || 'unknown'}`);
  for (const h of installed) {
    if (h === 'claude-code') { say('  claude-code: installed from the Claude Code in-app marketplace (version shown there)'); continue; }
    const ls = run(NPM, ['ls', '-g', `@ours.network/${h}`], { capture: true }).out;
    const m = ls.match(new RegExp(`@ours\\.network/${h}@[0-9][0-9.]*`));
    say(`  ${h}: ${m ? m[0] : `@ours.network/${h} (not a global install)`}`);
  }
  if (installed.length) { say('installed:'); for (const h of installed) say(`  ✓ ${h}`); }
  if (failed.length) say(`note: failed to fully set up: ${failed.join(' ')} — re-run or install those directly.`);
  line('');
  say('Next: reload each harness to load the ours tools (Hermes: \'/reload-mcp\'; Codex: new thread).');
  say('In your agent: bind or create an identity, then ask it to wake you on new mail.');
  if (installed.includes('codex')) {
    const live = (process.env.OURS_CODEX_LIVE || 'yes').toLowerCase() !== 'no';
    say(live
      ? 'Codex live mode: start with \'ours-codex\'; bind an identity, then explicitly approve arming.'
      : 'Codex standard mode: start with \'codex\'; monitoring offers an explicitly approved blocking fallback.');
    say('Codex will ask you to review the native plugin hooks; the installer never bypasses hook trust.');
  }
  say('Wake-on-mail is always consent-first — see your plugin README. Docs: https://ours.network');
  if (firstInstall) { line(''); line(nextStepsPanel(rootIdentity)); }
  finish(ttyFd);
}

// The framed send-off after a successful FIRST install (never on upgrade runs) — the owner's
// finalized 4-step how-to + the optional auto-wake line. When the root identity could not be
// created, the first line degrades to the generic "create your identity".
function nextStepsPanel(rootIdentity) {
  const opener = rootIdentity
    ? [`Your ours identity "${rootIdentity}" is set up — that's you (the human).`]
    : ["You're set up. First tell your agent to create your (human) identity."];
  return box([
    ...opener,
    '',
    'Now open your harness (Claude Code / Codex / Hermes) — the ours',
    'skill is already installed — and just tell your agent:',
    '',
    '  1. "Create an agent identity called <agent-name>"',
    '       -> gives your agent its own identity under you.',
    '  2. "Generate an invite for <friend>"',
    '       -> share the invite text it prints.',
    '  3. Your friend, in their agent: "Add this contact" + paste it.',
    '  4. Then either side: "Send a message to <name>: hi"',
    '       · "Check my messages"',
    '',
    'Optional - auto-wake: tell Codex "watch for messages". ours-codex gives',
    'background wake; normal codex offers a consent-gated foreground fallback.',
    '',
    'To link two of your OWN agents: open a second harness window,',
    '"create an agent identity" there too, "generate an invite" in one,',
    '"add this contact" (paste) in the other - now they can chat.',
  ], 'next steps');
}

function finish(ttyFd) {
  wizardLeave(); // idempotent — never leave the terminal on the alternate screen
  if (ttyFd != null) { try { closeSync(ttyFd); } catch { /* ignore */ } }
}

main().catch((e) => {
  // Same philosophy as everywhere else: degrade, don't crash — one honest line, non-zero exit.
  wizardLeave();
  say(`unexpected error: ${String(e)}`);
  process.exitCode = 1;
});
