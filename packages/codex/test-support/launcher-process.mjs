import { EventEmitter } from 'node:events';
import { runLauncher } from '../src/launcher.mjs';

const scenario = process.argv[2];
const report = { settled: false, deadlines: 0, referenced: false, fired: false, firedAfterSettled: null, cleared: false, kills: [] };
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
let deadline;

// Accelerate only the production cleanup deadline. Keep a real, referenced Node
// timer so a losing timeout still prevents natural exit on the broken launcher.
globalThis.setTimeout = (callback, ms, ...args) => {
  if (ms !== 30_000) return realSetTimeout(callback, ms, ...args);
  report.deadlines += 1;
  deadline = realSetTimeout(() => {
    report.fired = true;
    report.firedAfterSettled = report.settled;
    callback(...args);
  }, 100);
  report.referenced = deadline.hasRef();
  return deadline;
};
globalThis.clearTimeout = (timer) => {
  if (timer === deadline) report.cleared = true;
  return realClearTimeout(timer);
};

function child(name) {
  const proc = new EventEmitter();
  proc.exitCode = null;
  proc.signalCode = null;
  proc.kill = (signal) => {
    report.kills.push([name, signal]);
    if (name === 'end' && scenario === 'hung' && !report.fired) {
      throw new Error('cleanup killed before its deadline');
    }
    proc.signalCode = signal;
    proc.emit('exit', null, signal);
    return true;
  };
  return proc;
}

process.on('exit', () => process.stdout.write(`${JSON.stringify(report)}\n`));
try {
  report.result = await runLauncher({
    argv: [], env: {},
    profileResolver: async () => ({ port: 1, configPath: '/unused', baseUrl: 'http://unused', codexArgs: [] }),
    fetch: async () => ({ ok: true }),
    connect: async () => {
      if (scenario === 'startup-error') throw new Error('connect failed');
      return { onServerRequest() {}, onNotification() {}, close() {} };
    },
    spawn: (_command, args) => {
      const name = args.includes('session-end') ? 'end' : args[0] === '--remote' ? 'tui' : 'app-server';
      const proc = child(name);
      if (name === 'tui' || (name === 'end' && scenario !== 'hung')) {
        queueMicrotask(() => {
          if (name === 'end' && scenario === 'cleanup-error') {
            proc.emit('error', new Error('session-end spawn failed'));
            return;
          }
          proc.exitCode = name === 'tui' && scenario === 'nonzero' ? 7 : 0;
          if (name === 'tui' && scenario === 'signal') {
            proc.exitCode = null;
            proc.signalCode = 'SIGINT';
          }
          proc.emit('exit', proc.exitCode, proc.signalCode);
        });
      }
      return proc;
    },
  });
  process.exitCode = report.result;
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
}
report.settled = true;
// No process.exit(): the parent must observe the launcher's natural termination.
