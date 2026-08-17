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
  runFails = [], voiceReady = false, interactiveOk = true,
} = {}) {
  const recorder = { ran: [], ranEnv: [], wrote: [], out: [], asked: [], askedLines: [], interactive: [] };
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
    username: () => 'me',
    detectHarnesses: () => harnesses,
    clipboard: () => false,
    now: () => 1,
    probe: (port) => net[port] ?? { ok: false, reason: 'connection refused' },
    isTaken: (port) => taken.includes(port),
    readJson: (p) => (Object.prototype.hasOwnProperty.call(json, p) ? json[p] : null),
    readText: (p) => (Object.prototype.hasOwnProperty.call(text, p) ? text[p] : null),
    writeJson: (p, body) => { recorder.wrote.push([p, body]); },
    run: async (cmd, cmdArgs, opts = {}) => {
      const invocation = [cmd, ...cmdArgs];
      recorder.ran.push(invocation);
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
