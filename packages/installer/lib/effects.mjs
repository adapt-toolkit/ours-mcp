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
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { atomicWriteConfig } from './config.mjs';
import { askYesNo } from './prompt.mjs';

/** GET http://127.0.0.1:<port>/state-dir — the unauthenticated identity probe. */
async function probePort(port, { timeoutMs = 1500 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/state-dir`, { signal: controller.signal });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const body = await res.json();
    if (typeof body?.stateDir !== 'string') return { ok: false, reason: 'no stateDir in reply' };
    return { ok: true, stateDir: body.stateDir };
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

function installedVersionOf(pkg) {
  try {
    const out = execFileSync('npm', ['ls', '-g', '--depth', '0', '--json', pkg], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return JSON.parse(out)?.dependencies?.[pkg]?.version ?? null;
  } catch {
    // Unreadable is NOT "new enough": the cowork gate fails closed on null.
    return null;
  }
}

/**
 * Build the real effects. `write` and `ttyFd` come from the caller's UI layer so
 * the orchestrator never reaches for a terminal itself.
 */
export function realEffects({ write, ttyFd, env = process.env, home = homedir(), out } = {}) {
  return {
    home,
    env,
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
    // `extraEnv` is the daemon pair (see daemonEnv). It is applied to THIS
    // invocation only and never to the installer's own process: a state
    // directory selected by one run must not leak into anything the operator
    // starts afterwards.
    run: async (cmd, args, { env: extraEnv = null } = {}) => {
      // Always built from this layer's OWN env rather than left to spawnSync's
      // implicit inheritance, so what a child receives is a property of the
      // effects object a caller constructed and not of whatever ambient shell
      // the installer happened to start in.
      const childEnv = { ...env, ...(extraEnv ?? {}) };
      const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: childEnv });
      if (r.status !== 0) {
        const detail = (r.stderr || r.stdout || '').trim().split('\n').slice(-3).join('; ');
        throw new Error(`${cmd} ${args.join(' ')} exited ${r.status}${detail ? `: ${detail}` : ''}`);
      }
      return { ok: true, code: r.status, stdout: r.stdout ?? '' };
    },
    installedVersion: installedVersionOf,
    out: out ?? ((line) => process.stdout.write(`${line}\n`)),
    // Never called when assumeYes: the orchestrator takes the default itself.
    ask: async (prompt, def = false) => (ttyFd == null ? def : askYesNo(write, ttyFd, `  ${prompt}  `, def)),
  };
}

export const __testables = { probePort, portTakenSync, readJsonFile, readTextFile, installedVersionOf };

// -----------------------------------------------------------------------------
// THE PAIR
// -----------------------------------------------------------------------------

/**
 * The environment that names ONE daemon, for a single child invocation.
 *
 * Spec §2's rule is that a state directory and an endpoint always travel
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
