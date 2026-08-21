// The recording effects layer the orchestrator tests are written against.
//
// Shared rather than copied because this fake IS the effects contract: if it
// drifts from lib/effects.mjs, every test that uses it is testing a machine that
// does not exist. One definition, one place to notice the drift.
//
// `json`/`text` seed the filesystem; `net` seeds the probe; `harnesses` seeds
// detection; everything mutating is RECORDED rather than done — which is what
// makes it safe to walk the whole installer on a host running the live fleet.
//
// (This file lives under test/ and defines no tests of its own. Node's runner
// loads it and reports zero tests, which is the intended outcome.)
import { resolve } from 'node:path';

export const HOME = '/home/me';
export const OURS = resolve(HOME, '.ours');
export const TG = resolve(HOME, '.ours-tg');

export function fx({
  json = {}, text = {}, net = {}, taken = [], versions = {}, env = {}, answers = [],
  unitUnchanged = false, harnesses = [], lines = [], platform = 'linux', nodeVersion = '22.0.0',
  runFails = [], voiceReady = false, interactiveOk = true, restoreFails = [], known = [],
  restoreDoesNotTake = [], restoreChangesMode = [],
} = {}) {
  // A restore that RETURNS without the bytes landing — the case a read-back
  // catches and a returning call cannot. Distinct from `restoreFails`, which
  // throws: this one succeeds loudly and lies quietly.
  const notTaken = new Set();
  const modeDrifted = new Set();
  const recorder = { ran: [], ranEnv: [], wrote: [], wroteText: [], out: [], asked: [], askedLines: [], interactive: [], restored: [] };
  let answerIndex = 0;
  let lineIndex = 0;
  const fails = (cmd) => runFails.some((f) => cmd.join(' ').includes(f));
  return {
    recorder,
    home: HOME,
    env,
    brokerUrl: 'wss://broker1.ours.network',
    version: '9.9.9',
    platform: { platform, release: '6.0.0' },
    nodeVersion,
    exists: () => false,
    // Detection for the selection screen. Empty by default so a test that says
    // nothing about existing daemons gets the same walk it always had: nothing
    // detected, no screen, the default state directory.
    knownStateDirs: () => known,
    username: () => 'me',
    detectHarnesses: () => harnesses,
    clipboard: () => false,
    now: () => 1,
    probe: (port) => net[port] ?? { ok: false, reason: 'connection refused' },
    isTaken: (port) => taken.includes(port),
    readJson: (p) => (Object.prototype.hasOwnProperty.call(json, p) ? json[p] : null),
    readText: (p) => (Object.prototype.hasOwnProperty.call(text, p) ? text[p] : null),
    writeJson: (p, body) => { recorder.wrote.push([p, body]); },
    writeText: (p, body) => { recorder.wroteText.push([p, body]); },
    // The rollback seam. `snapshot` returns what the file looked like before the
    // run — seeded from `json`, exactly as readJson is, so a test does not have to
    // describe the same file twice — and `restore` is RECORDED rather than done,
    // which is what lets a test assert that the bytes went back without a
    // filesystem. `restoreFails` makes the failure path reachable.
    snapshot: (p) => {
      const had = Object.prototype.hasOwnProperty.call(json, p);
      // Once a restore has been claimed but did not take, the read-back is what
      // the file ACTUALLY says — which is the whole point of reading it back.
      if (notTaken.has(p)) return { exists: true, text: had ? 'these are not the previous bytes\n' : '{}\n', mode: 0o600 };
      return { exists: had, text: had ? `${JSON.stringify(json[p], null, 2)}\n` : '', mode: modeDrifted.has(p) ? 0o644 : 0o600 };
    },
    restore: (p, snap) => {
      if (restoreFails.includes(p)) throw new Error('permission denied');
      if (restoreDoesNotTake.includes(p)) notTaken.add(p);
      if (restoreChangesMode.includes(p)) modeDrifted.add(p);
      recorder.restored.push([p, snap]);
    },
    run: async (cmd, cmdArgs, opts = {}) => {
      const invocation = [cmd, ...cmdArgs];
      recorder.ran.push(invocation);
      // install-service WRITES the unit. `unitUnchanged` models the case where the
      // bytes it writes are the bytes already there — which is what the run reads
      // back to decide whether anything moved, now that no --json reports it.
      if (cmdArgs.includes('install-service') && !unitUnchanged) {
        for (const p of Object.keys(text)) if (p.includes('systemd')) text[p] = `${text[p] ?? ''}\n# rewritten`;
      }
      // Recorded separately so deepEqual assertions on `ran` keep working; the
      // pair invariant is checked against this.
      recorder.ranEnv.push(opts.env ?? null);
      if (fails(invocation)) throw new Error(`${cmd} exited 1`);
      const stdout = cmdArgs.includes('install-service') && cmdArgs.includes('--json')
        ? JSON.stringify({ changed: unitUnchanged ? false : true, unitName: 'ours.service' })
        : cmdArgs.includes('voice-status')
          ? JSON.stringify({ ready: voiceReady, provider: voiceReady ? 'deepgram' : '' })
          : '';
      return { ok: true, code: 0, stdout };
    },
    runInteractive: async (cmd, cmdArgs, opts = {}) => {
      recorder.interactive.push([cmd, ...cmdArgs]);
      recorder.ran.push([cmd, ...cmdArgs]);
      recorder.ranEnv.push(opts.env ?? null);
      return { ok: interactiveOk, code: interactiveOk ? 0 : 1 };
    },
    installedVersion: (pkg) => versions[pkg] ?? null,
    installedVersions: versions,
    out: (line) => recorder.out.push(String(line)),
    ask: async (prompt) => { recorder.asked.push(prompt); return answers[answerIndex++] ?? false; },
    askLine: async (prompt, def = '') => { recorder.askedLines.push(prompt); return lines[lineIndex++] ?? def; },
  };
}

export const said = (e) => e.recorder.out.join('\n');
