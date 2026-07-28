import * as fs from 'node:fs';
import { join } from 'node:path';

export const STARTUP_PROGRESS_FILENAME = 'startup-progress.json';
export const STARTUP_PROGRESS_VERSION = 1;

export type StartupPhase =
  | 'initializing'
  | 'wrapper'
  | 'registrar'
  | 'identities'
  | 'reconciliation'
  | 'server'
  | 'ready'
  | 'failed';

export interface StartupProgress {
  version: typeof STARTUP_PROGRESS_VERSION;
  pid: number;
  bootId: string;
  phase: StartupPhase;
  completed?: number;
  total?: number;
  startedAt: number;
  updatedAt: number;
}

export interface StartupProgressReporter {
  update(phase: StartupPhase, counts?: { completed: number; total: number }): void;
  ready(): void;
  failed(): void;
}

const PHASE_LABELS: Record<StartupPhase, string> = {
  initializing: 'Initializing daemon',
  wrapper: 'Starting protocol runtime',
  registrar: 'Starting local contact book',
  identities: 'Restoring identities',
  reconciliation: 'Reconciling restored identities',
  server: 'Opening local API',
  ready: 'Daemon ready',
  failed: 'Daemon startup failed',
};

export function startupProgressPath(stateDir: string): string {
  return join(stateDir, STARTUP_PROGRESS_FILENAME);
}

function isStartupPhase(value: unknown): value is StartupPhase {
  return typeof value === 'string' && Object.hasOwn(PHASE_LABELS, value);
}

export function readStartupProgress(stateDir: string): StartupProgress | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(startupProgressPath(stateDir), 'utf8')) as Partial<StartupProgress>;
    if (
      parsed.version !== STARTUP_PROGRESS_VERSION ||
      !Number.isInteger(parsed.pid) ||
      (parsed.pid ?? 0) <= 0 ||
      typeof parsed.bootId !== 'string' ||
      !parsed.bootId ||
      !isStartupPhase(parsed.phase) ||
      !Number.isFinite(parsed.startedAt) ||
      !Number.isFinite(parsed.updatedAt)
    ) {
      return null;
    }
    const hasCounts = parsed.completed !== undefined || parsed.total !== undefined;
    if (
      hasCounts &&
      (!Number.isInteger(parsed.completed) ||
        !Number.isInteger(parsed.total) ||
        (parsed.completed ?? -1) < 0 ||
        (parsed.total ?? -1) < 0 ||
        (parsed.completed ?? 0) > (parsed.total ?? 0))
    ) {
      return null;
    }
    return parsed as StartupProgress;
  } catch {
    return null;
  }
}

export function createStartupProgressReporter(
  stateDir: string,
  opts: { heartbeatMs?: number; pid?: number; now?: () => number } = {},
): StartupProgressReporter {
  const pid = opts.pid ?? process.pid;
  const now = opts.now ?? Date.now;
  const startedAt = now();
  const path = startupProgressPath(stateDir);
  const tmp = `${path}.${pid}.tmp`;
  const heartbeatMs = Math.max(100, opts.heartbeatMs ?? 2_000);
  let stopped = false;
  let writeDisabled = false;
  let progress: StartupProgress = {
    version: STARTUP_PROGRESS_VERSION,
    pid,
    bootId: `${pid}-${startedAt}`,
    phase: 'initializing',
    startedAt,
    updatedAt: startedAt,
  };

  const write = () => {
    if (writeDisabled) return;
    try {
      fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(tmp, `${JSON.stringify(progress)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, path);
      try { fs.chmodSync(path, 0o600); } catch { /* best effort on non-POSIX platforms */ }
    } catch {
      // Progress is observability, never a startup dependency. Disable repeated
      // writes after the first failure so an unwritable state dir cannot create
      // a hot error loop or mask the daemon's real startup result.
      writeDisabled = true;
      try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    }
  };

  const update = (phase: StartupPhase, counts?: { completed: number; total: number }) => {
    progress = {
      version: STARTUP_PROGRESS_VERSION,
      pid,
      bootId: progress.bootId,
      phase,
      ...(counts ? { completed: counts.completed, total: counts.total } : {}),
      startedAt,
      updatedAt: now(),
    };
    write();
  };

  write();
  const heartbeat = setInterval(() => {
    if (stopped) return;
    progress = { ...progress, updatedAt: now() };
    write();
  }, heartbeatMs);
  heartbeat.unref?.();

  const finish = (phase: 'ready' | 'failed') => {
    if (stopped) return;
    update(phase);
    stopped = true;
    clearInterval(heartbeat);
  };

  return {
    update,
    ready: () => finish('ready'),
    failed: () => finish('failed'),
  };
}

export function formatStartupProgress(progress: StartupProgress): string {
  const base = PHASE_LABELS[progress.phase];
  if (
    progress.phase === 'identities' &&
    progress.completed !== undefined &&
    progress.total !== undefined
  ) {
    return `${base} ${progress.completed}/${progress.total}`;
  }
  return base;
}

export function renderStartupProgress(progress: StartupProgress, interactive: boolean): string {
  const line = `startup: ${formatStartupProgress(progress)}`;
  return interactive ? `\r${line}\x1b[K` : `${line}\n`;
}

export type StartupWaitFailure =
  | 'process-exited'
  | 'daemon-reported-failure'
  | 'inactivity-timeout'
  | 'absolute-timeout';

export type StartupWaitResult =
  | { ok: true; elapsedMs: number; lastProgress: StartupProgress | null }
  | {
      ok: false;
      reason: StartupWaitFailure;
      elapsedMs: number;
      lastProgress: StartupProgress | null;
    };

export interface StartupWaitOptions {
  pid: number;
  absoluteMs: number;
  inactivityMs: number;
  pollMs: number;
  isProcessAlive: () => boolean;
  isReady: () => Promise<boolean>;
  readProgress: () => StartupProgress | null;
  onProgress?: (progress: StartupProgress) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export async function waitForStartup(opts: StartupWaitOptions): Promise<StartupWaitResult> {
  const now = opts.now ?? Date.now;
  const wait = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const startedAt = now();
  let lastActivityAt = startedAt;
  let lastUpdatedAt = -1;
  let lastDisplay = '';
  let lastProgress: StartupProgress | null = null;

  while (true) {
    if (await opts.isReady()) {
      return { ok: true, elapsedMs: now() - startedAt, lastProgress };
    }

    const observed = opts.readProgress();
    if (observed?.pid === opts.pid) {
      lastProgress = observed;
      if (observed.updatedAt > lastUpdatedAt) {
        lastUpdatedAt = observed.updatedAt;
        lastActivityAt = now();
      }
      const display = `${observed.phase}:${observed.completed ?? ''}:${observed.total ?? ''}`;
      if (display !== lastDisplay) {
        lastDisplay = display;
        opts.onProgress?.(observed);
      }
      if (observed.phase === 'failed') {
        return {
          ok: false,
          reason: 'daemon-reported-failure',
          elapsedMs: now() - startedAt,
          lastProgress,
        };
      }
    }

    if (!opts.isProcessAlive()) {
      return {
        ok: false,
        reason: 'process-exited',
        elapsedMs: now() - startedAt,
        lastProgress,
      };
    }

    const elapsedMs = now() - startedAt;
    if (elapsedMs >= opts.absoluteMs) {
      return { ok: false, reason: 'absolute-timeout', elapsedMs, lastProgress };
    }
    if (now() - lastActivityAt >= opts.inactivityMs) {
      return { ok: false, reason: 'inactivity-timeout', elapsedMs, lastProgress };
    }

    const absoluteRemaining = opts.absoluteMs - elapsedMs;
    const inactivityRemaining = opts.inactivityMs - (now() - lastActivityAt);
    await wait(Math.max(1, Math.min(opts.pollMs, absoluteRemaining, inactivityRemaining)));
  }
}
