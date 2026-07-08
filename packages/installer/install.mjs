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
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { banner, section, heading, ok, step, info, warn, c, openTty, makeWriter, closeSync } from './lib/ui.mjs';
import { askLine, askYesNo, checkboxSelect } from './lib/prompt.mjs';
import {
  canonHarnesses, suggestPort, parsePort, validateBroker, mergeConfig, parseVersion, parseStatus,
  DEFAULT_BROKER, DEFAULT_PORT, RESERVED_PORTS,
} from './lib/logic.mjs';

const NPM = process.env.OURS_NPM || 'npm';
const say = (s) => process.stdout.write(`ours: ${s}\n`);
const line = (s = '') => process.stdout.write(`${s}\n`);

// --- external command helpers (never throw; the installer degrades, it doesn't crash) ----------
function run(bin, args, { capture = false } = {}) {
  const r = spawnSync(bin, args, {
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  return { code: r.status ?? (r.error ? -1 : 0), out: r.stdout || '', err: r.stderr || '', ok: !r.error && r.status === 0 };
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
function main() {
  const ttyFd = openTty();
  const interactive = ttyFd != null && !process.env.OURS_ASSUME_YES;
  const write = makeWriter(ttyFd);

  line(banner());
  say('This sets up your local ours node and connects the AI agents you choose.');

  // --- 1) daemon: ensure @latest (upgrade, not install-if-missing) + restart on change ---------
  line(section(1, 'ours daemon'));
  line(info('The daemon is your local ours node — it keeps your connection to the mesh alive.'));
  const before = parseVersion(daemonVersionLine());
  line(step('ensuring @ours.network/mcp@latest…'));
  run(NPM, ['i', '-g', '@ours.network/mcp@latest']);
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

  // Read the daemon's RESOLVED broker + port so we prompt with real values, not a hardcoded guess.
  const status = parseStatus(daemonStatusText());
  const brokerCurrent = status.broker || DEFAULT_BROKER;
  const portCurrent = status.port || DEFAULT_PORT;

  // --- 2) persistent service (optional) --------------------------------------------------------
  line(section(2, 'persistent service'));
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
  line(section(3, 'broker address'));
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
  line(section(4, 'HTTP port'));
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
  line(section(5, 'agent harnesses'));
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
    line(heading('Done'));
    say('Daemon is set up. No harness selected — re-run any time, or install one directly:');
    say('  npm i -g @ours.network/{hermes,codex} && ours-<harness>-install');
    finish(ttyFd);
    return;
  }
  say(`setting up: ${selected.join(' ')}`);

  // Honest maturity note: Claude Code's wake-on-mail monitor is the most tested; Codex/Hermes are
  // newer. Show it briefly (1-2 lines) when a non-Claude-Code harness is selected.
  const NON_CC = selected.filter((h) => h !== 'claude-code');
  if (NON_CC.length) {
    line(info(`Note: Claude Code has the most tested, reliable wake-on-mail monitor; ${NON_CC.join(' & ')} support is`));
    line(info('newer and may have rough edges — please report anything off: ' + c.cyan('https://github.com/adapt-toolkit/ours-mcp/issues')));
  }

  // --- 6) run each selected harness's installer ------------------------------------------------
  const installed = [];
  const failed = [];
  for (const h of selected) {
    if (h === 'claude-code') {
      line(heading('→ claude-code'));
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
      line(heading(`→ ${h}`));
      line(step(`installing @ours.network/${h}@latest…`));
      run(NPM, ['i', '-g', `@ours.network/${h}@latest`]);
      line(step(`running ours-${h}-install`));
      if (run(`ours-${h}-install`, []).ok) { line(ok(`${h} installed and working.`)); installed.push(h); }
      else { line(warn(`${h} setup failed (continuing).`)); failed.push(h); }
    }
  }

  // --- 7) end screen — brief "how to use" + versions -------------------------------------------
  line(heading('Done'));
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
  say('Next: reload each harness to load the ours tools (Hermes: \'/reload-mcp\'; Codex: next session).');
  say('In your agent: bind or create an identity, then ask it to wake you on new mail.');
  say('Wake-on-mail: enable it in-session — see your plugin\'s README. Docs: https://ours.network');
  if (installed.some((h) => h !== 'claude-code')) {
    say('Heads-up: Claude Code\'s monitor is the most tested; Codex/Hermes are newer — report issues:');
    say('  https://github.com/adapt-toolkit/ours-mcp/issues');
  }
  finish(ttyFd);
}

function finish(ttyFd) {
  if (ttyFd != null) { try { closeSync(ttyFd); } catch { /* ignore */ } }
}

main();
