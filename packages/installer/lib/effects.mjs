// ours-install v3 — the real side effects.
//
// Every mutation the installer can perform lives here and nowhere else, behind
// the same contract lib/orchestrate.mjs is tested against. Keeping them in one
// small file is the point: it is the only place to audit for "does this touch
// the machine", and it is what makes the fake used in the tests a faithful
// stand-in rather than an approximation.
//
// NOTE: nothing here runs systemctl. systemd is reached ONLY through
// `ours daemon install-service`, which owns the marker check, the baked
// state-directory guard and the enable/reload. The installer never touches a
// unit file or the service manager directly.

import { spawnSync, execFileSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, userInfo, platform as osPlatform, release as osRelease } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { atomicWriteConfig, snapshotConfig, restoreConfig } from './config.mjs';
import { askYesNo, askLine as askLineOnTty } from './prompt.mjs';
import { classifyHarnessProbe } from './logic.mjs';
import { classifyStateDir } from './detect.mjs';

/** GET http://127.0.0.1:<port>/state-dir — the unauthenticated identity probe. */
async function probePort(port, { timeoutMs = 1500 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/state-dir`, { signal: controller.signal });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const body = await res.json();
    if (typeof body?.stateDir !== 'string') return { ok: false, reason: 'no stateDir in reply' };
    return {
      ok: true,
      stateDir: body.stateDir,
      version: typeof body.version === 'string' ? body.version : null,
      compat: Number.isInteger(body.compat) ? body.compat : null,
    };
  } catch (error) {
    return { ok: false, reason: error?.name === 'AbortError' ? 'timed out' : String(error?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Is this port bound? Probed in a throwaway child so a bind attempt cannot leave
 * a listener behind in this process — the same technique the existing installer
 * uses (install.mjs portTakenSync).
 */
function portTakenSync(port) {
  const src = `const net=require('net');const s=net.createServer();s.once('error',e=>{process.exit(e.code==='EADDRINUSE'?3:0)});s.listen(${port},'127.0.0.1',()=>{s.close(()=>process.exit(0))});`;
  return spawnSync(process.execPath, ['-e', src], { stdio: 'ignore' }).status === 3;
}

function readJsonFile(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function readTextFile(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function installedVersionOf(pkg, npmBin = 'npm') {
  try {
    const out = execFileSync(npmBin, ['ls', '-g', '--depth', '0', '--json', pkg], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return JSON.parse(out)?.dependencies?.[pkg]?.version ?? null;
  } catch {
    // Unreadable is NOT "new enough": the cowork gate fails closed on null.
    return null;
  }
}

function packageDependenciesOf(pkgSpec, npmBin = 'npm') {
  const probe = capture(npmBin, ['view', pkgSpec, 'dependencies', '--json'], { timeout: 15_000 });
  if (!probe.ok) return null;
  try {
    const parsed = JSON.parse(probe.stdout);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function resolvePackageVersion(pkg, channel, npmBin = 'npm') {
  const tag = channel === 'nightly' ? 'nightly' : 'latest';
  const probe = capture(npmBin, ['view', `${pkg}@${tag}`, 'version', '--json'], { timeout: 15_000 });
  if (!probe.ok) return '';
  try {
    const parsed = JSON.parse(probe.stdout);
    return typeof parsed === 'string' ? parsed : '';
  } catch {
    return /^\S+$/.test(probe.stdout.trim()) ? probe.stdout.trim() : '';
  }
}

function codexMarketplace() {
  const probe = capture('codex', ['plugin', 'marketplace', 'list', '--json'], { timeout: 6_000 });
  if (!probe.ok) return null;
  try {
    return JSON.parse(probe.stdout)?.marketplaces?.find((m) => m?.name === 'ours-codex-marketplace') ?? null;
  } catch { return null; }
}

function hasClaudePlugin() {
  const probe = capture('claude', ['plugin', 'list', '--json'], { timeout: 6_000 });
  if (!probe.ok) return false;
  try { return JSON.parse(probe.stdout)?.some((p) => p?.id === 'ours@ours.network') ?? false; }
  catch { return false; }
}

/**
 * A read-only command probe that NEVER throws and NEVER inherits stdio.
 *
 * Separate from `run` on purpose. `run` is for mutations and throws on a
 * non-zero exit, because a failed mutation is news. Detection is the opposite:
 * a non-zero exit IS the answer, and a hung wrapper must be killed rather than
 * waited on. Mixing the two would mean either detection crashes a run or a
 * failed install passes silently.
 */
function capture(cmd, args, { timeout, env = process.env } = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'], env });
  const timedOut = !!(r.error && (r.error.code === 'ETIMEDOUT' || r.signal === 'SIGTERM'));
  return {
    ok: !r.error && r.status === 0,
    code: r.status ?? -1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    timedOut,
  };
}

// The two harnesses that are DRIVEN CLIs. The `name` is the one lib/extras.mjs
// plans against; the `command` is what actually lives on PATH.
export const DRIVEN_HARNESSES = [
  { name: 'claude-code', command: 'claude', label: 'Claude Code' },
  { name: 'codex', command: 'codex', label: 'Codex' },
];

/**
 * Alias-safety, unchanged from v2: three read-only observations, then the pure
 * classifier decides. The harness is NEVER called in a way that can hang —
 * `--version` is spawned directly (no shell, so a real PATH binary) under a hard
 * timeout, and the shell `type` lookup is timeout-guarded too.
 */
function detectDrivenHarness({ name, command, label }, env) {
  const onPath = capture('bash', ['-c', `command -v ${command}`], { env }).ok;
  const probe = capture(command, ['--version'], { timeout: 6000, env });
  const versionOk = probe.ok && /\d+\.\d+/.test(probe.stdout);
  const shell = env.SHELL || '/bin/bash';
  const typeProbe = capture(shell, ['-ic', `type -t ${command} 2>/dev/null`], { timeout: 4000, env });
  const verdict = classifyHarnessProbe({
    onPath, versionOk, timedOut: probe.timedOut, shellType: (typeProbe.stdout || '').trim(),
  });
  return { name, command, label, ...verdict };
}

/**
 * Hermes is detected DIFFERENTLY, and it is not an inconsistency. Its ours
 * plugin never calls a `hermes` binary — `ours-hermes-install` writes
 * ~/.hermes/config.yaml and the skills — so "can we drive it?" is the wrong
 * question. Per the plugin's own prerequisites, presence IS the config
 * directory. The CLI probe still runs, purely to enrich detection.
 */
function detectHermesHarness(env, home) {
  const dir = env.HERMES_DIR || join(home, '.hermes');
  const dirPresent = existsSync(dir);
  const cli = detectDrivenHarness({ name: 'hermes', command: 'hermes', label: 'Hermes' }, env);
  return {
    name: 'hermes',
    command: 'hermes',
    label: 'Hermes',
    status: dirPresent || cli.status === 'ok' ? 'ok' : 'absent',
    detail: dirPresent ? `config dir ${dir} present` : cli.detail,
  };
}

/**
 * Best-effort clipboard copy (pbcopy / wl-copy / xclip / clip.exe). The hard
 * timeout is load-bearing: xclip holds the selection and would otherwise keep
 * the installer alive after its own summary.
 */
function copyToClipboard(text) {
  const tools = [['pbcopy', []], ['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['clip.exe', []]];
  for (const [bin, args] of tools) {
    try {
      const r = spawnSync(bin, args, { input: text, timeout: 2000 });
      if (!r.error && (r.status === 0 || r.status == null)) return true;
    } catch { /* try the next one */ }
  }
  return false;
}

/**
 * Every DAEMON state directory on this machine.
 *
 * ONE DEFINITION OF WHAT A DAEMON IS, and this function is why that matters.
 *
 * It used to count any `~/.ours*` directory containing a config.json. Two of those
 * are not daemons on a perfectly normal machine: `~/.ours-telegram/config.json` is
 * the Telegram connector's and `~/.ours-cowork/config.json` is cowork's. So the
 * uninstaller reported "@ours.network/cli kept — still used by the daemon at
 * ~/.ours-telegram", and two things followed silently:
 *
 *   · planGlobalPackages kept cli, mcp and the plugin packages FOREVER on any
 *     machine with the connector installed, naming a connector's config directory
 *     as a daemon;
 *   · worse, planPluginRemoval's `lastDaemon` went false, so the whole harness
 *     plugin phase was skipped — with a reason that was not true. A plain
 *     interactive `ours-uninstall` on a machine with the connector removed no
 *     plugins at all.
 *
 * The selection screen had already closed exactly this: config.json is the one
 * piece of evidence that is AMBIGUOUS, so it cannot be the test. That predicate
 * lives in lib/detect.mjs and this now calls it rather than keeping a second,
 * naive copy that drifted. A daemon is identified by an artefact only a daemon
 * writes, or by a config whose SHAPE is a daemon's.
 *
 * Still deliberately conservative about WHERE it looks: only `~/.ours` and its
 * `~/.ours*` siblings. A state directory somewhere else is not found, and an
 * unreadable home means "there might be others", not "there are none" — because
 * the caller uses this to decide whether a GLOBAL package is still needed, and
 * being wrong the optimistic way uninstalls the CLI out from under a running
 * daemon.
 */
function knownStateDirsIn(home) {
  const found = [];
  const io = { exists: existsSync, readJson: readJsonFile };
  const consider = (dir) => { if (classifyStateDir(dir, io).isDaemon) found.push(dir); };
  consider(join(home, '.ours'));
  try {
    for (const entry of readdirSync(home, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('.ours') || entry.name === '.ours') continue;
      consider(join(home, entry.name));
    }
  } catch { /* an unreadable home is not evidence that there are no others */ }
  return found;
}

/**
 * Build the real effects. `write` and `ttyFd` come from the caller's UI layer so
 * the orchestrator never reaches for a terminal itself.
 */
export function realEffects({ write, ttyFd, env = process.env, home = homedir(), out, version = null } = {}) {
  const npmBin = env.OURS_NPM?.trim() || 'npm';
  return {
    home,
    env,
    version,
    // Preflight reads the machine rather than asking the orchestrator to.
    platform: { platform: osPlatform(), release: osRelease() },
    nodeVersion: process.versions.node,
    exists: (path) => existsSync(path),
    knownStateDirs: () => knownStateDirsIn(home),
    // The only irreversible effect in this package, and the reason it takes no
    // pattern and no parent: the caller passes ONE resolved directory that the
    // pure planner already gated four ways, and this deletes exactly that.
    removeDir: (path) => { rmSync(resolve(path), { recursive: true, force: true }); },
    removeFile: (path) => { rmSync(resolve(path), { force: true }); },
    copyDir: (source, destination) => {
      mkdirSync(dirname(resolve(destination)), { recursive: true, mode: 0o700 });
      cpSync(resolve(source), resolve(destination), {
        recursive: true,
        errorOnExist: true,
        force: false,
        preserveTimestamps: true,
      });
    },
    // Rewrites a config file we do NOT own, so it keeps the file's own mode
    // rather than imposing 0600: tightening the permissions of somebody else's
    // ~/.codex/config.toml is a side effect nobody asked this to have.
    //
    // DO NOT "IMPROVE" THIS TO 0600. It looks like a security improvement, which
    // is exactly why someone will try — but this file is the operator's, not
    // ours, and the only thing we were invited to do to it is remove our own
    // block. Changing its mode on the way past is an uninvited change to a file
    // we happened to be holding, and a tool that does that once is a tool you
    // cannot let near your configs.
    writeText: (path, text) => {
      const mode = (() => { try { return statSync(path).mode & 0o777; } catch { return 0o644; } })();
      const temp = `${path}.tmp-${process.pid}`;
      writeFileSync(temp, text, { encoding: 'utf8', mode });
      renameSync(temp, path);
    },
    username: () => { try { return userInfo().username || 'me'; } catch { return 'me'; } },
    detectHarnesses: () => [
      ...DRIVEN_HARNESSES.map((h) => detectDrivenHarness(h, env)),
      detectHermesHarness(env, home),
    ],
    clipboard: (text) => copyToClipboard(text),
    brokerUrl: env.OURS_BROKER_URL ?? 'wss://broker1.ours.network',
    now: () => Date.now(),
    probe: (port) => probePort(port),
    isTaken: (port) => portTakenSync(port),
    readJson: readJsonFile,
    readText: readTextFile,
    writeJson: (path, text) => {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      atomicWriteConfig(path, text);
    },
    // The two halves of a config rollback (lib/journal.mjs). Deliberately the
    // SAME pair the nightly installer uses, from lib/config.mjs, rather than a
    // second implementation: `snapshot` records bytes and mode, and `restore`
    // either writes those bytes back at their original mode or DELETES a file
    // that did not exist before this run. Both are ordinary reads and writes of a
    // file this installer was already writing — no new class of side effect
    // enters the package here.
    snapshot: (path) => snapshotConfig(path),
    restore: (path, snapshot) => restoreConfig(path, snapshot),
    // `extraEnv` is the daemon pair (see daemonEnv). It is applied to THIS
    // invocation only and never to the installer's own process: a state
    // directory selected by one run must not leak into anything the operator
    // starts afterwards.
    run: async (cmd, args, { env: extraEnv = null, stream = false } = {}) => {
      // Always built from this layer's OWN env rather than left to spawnSync's
      // implicit inheritance, so what a child receives is a property of the
      // effects object a caller constructed and not of whatever ambient shell
      // the installer happened to start in.
      const childEnv = { ...env, ...(extraEnv ?? {}) };
      const executable = cmd === 'npm' ? npmBin : cmd;
      const r = spawnSync(executable, args, {
        encoding: 'utf8',
        stdio: stream ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'],
        env: childEnv,
      });
      if (r.status !== 0) {
        const detail = (r.stderr || r.stdout || '').trim().split('\n').slice(-3).join('; ');
        throw new Error(`${executable} ${args.join(' ')} exited ${r.status}${detail ? `: ${detail}` : ''}`);
      }
      return { ok: true, code: r.status, stdout: r.stdout ?? '' };
    },
    // The ONE invocation that must keep the user's terminal: `ours-mcp
    // voice-setup` is an interactive command with its own masked prompts, and
    // piping its stdio would hang it forever waiting on input nobody can type.
    // It is otherwise the same contract as `run` — including the environment,
    // so an interactive command reaches the same daemon a piped one would.
    runInteractive: async (cmd, args, { env: extraEnv = null } = {}) => {
      const r = spawnSync(cmd, args, { stdio: 'inherit', env: { ...env, ...(extraEnv ?? {}) } });
      return { ok: !r.error && r.status === 0, code: r.status ?? -1 };
    },
    installedVersion: (pkg) => installedVersionOf(pkg, npmBin),
    packageDependencies: (spec) => packageDependenciesOf(spec, npmBin),
    resolvePackageVersion: (pkg, channel) => resolvePackageVersion(pkg, channel, npmBin),
    codexMarketplace,
    hasClaudePlugin,
    out: out ?? ((line) => process.stdout.write(`${line}\n`)),
    // Never called when assumeYes: the orchestrator takes the default itself.
    ask: async (prompt, def = false) => (ttyFd == null ? def : askYesNo(write, ttyFd, `  ${prompt}  `, def)),
    askLine: async (prompt, def = '') => (ttyFd == null ? def : askLineOnTty(write, ttyFd, `  ${prompt}  `, def)),
  };
}

export const __testables = { probePort, portTakenSync, readJsonFile, readTextFile, installedVersionOf, packageDependenciesOf, resolvePackageVersion, codexMarketplace, hasClaudePlugin, knownStateDirsIn };

// -----------------------------------------------------------------------------
// THE PAIR
// -----------------------------------------------------------------------------

/**
 * The environment that names ONE daemon, for a single child invocation.
 *
 * A state directory and its endpoint always travel
 * together; "endpoint selected, state directory defaulted" must be unreachable.
 * Every consumer downstream — ours-mcp's proxy, ours-fleet's per-role resolver,
 * ours-hermes-install — reads these three names and falls back to `~/.ours` for
 * whichever one is missing. So a HALF pair does not fail: it silently attaches
 * to the default daemon while the operator was told a different one was chosen.
 *
 * That is why this is a function and not three assignments at the call sites.
 * There is exactly one place a daemon environment can be built, it takes both
 * halves as arguments, and it refuses rather than emit a partial one.
 *
 * The three names, not two, are deliberate: OURS_CONFIG alone would leave the
 * port to whatever config.json happens to say, which is exactly the stale-file
 * divergence lib/target.mjs's second lookup exists to survive.
 */
export const DAEMON_ENV_KEYS = ['OURS_CONFIG', 'OURS_STATE_DIR', 'OURS_PORT'];

export function daemonEnv(stateDir, port) {
  const dir = typeof stateDir === 'string' ? stateDir.trim() : '';
  if (!dir) throw new Error('daemonEnv requires a state directory: refusing to build half of the daemon pair');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('daemonEnv requires a port between 1 and 65535: refusing to build half of the daemon pair');
  }
  const resolved = resolve(dir);
  return {
    OURS_CONFIG: join(resolved, 'config.json'),
    OURS_STATE_DIR: resolved,
    OURS_PORT: String(port),
  };
}

/** Is this environment a whole pair (or nothing at all)? Never one half. */
export function isWholeDaemonEnv(env) {
  if (env == null) return true;
  const present = DAEMON_ENV_KEYS.filter((k) => typeof env[k] === 'string' && env[k] !== '');
  if (present.length === 0) return true;
  if (present.length !== DAEMON_ENV_KEYS.length) return false;
  return env.OURS_CONFIG === join(resolve(env.OURS_STATE_DIR), 'config.json');
}

/** The state directory a default run targets, for callers that need it early. */
export const defaultStateDir = (home = homedir()) => join(home, '.ours');
