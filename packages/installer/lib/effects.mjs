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
import { dirname, join } from 'node:path';
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
    run: async (cmd, args) => {
      const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
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

/** The state directory a default run targets, for callers that need it early. */
export const defaultStateDir = (home = homedir()) => join(home, '.ours');
