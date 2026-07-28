import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  atomicWriteVoiceConfig,
  runVoiceSetup,
  transactVoiceConfig,
  VOICE_PROVIDER_CHOICES,
} from '../dist/voice-setup.js';

const dir = mkdtempSync(join(tmpdir(), 'ours-voice-config-'));
try {
  assert.deepEqual(
    VOICE_PROVIDER_CHOICES.map(({ value }) => value),
    ['openai-compatible', 'elevenlabs', 'deepgram', 'custom'],
    'selector exposes every supported provider exactly once',
  );

  const fresh = join(dir, 'fresh.json');
  atomicWriteVoiceConfig(fresh, {
    unrelated: { keep: true },
    stt: { provider: 'deepgram', apiKey: 'unit-placeholder-secret' },
  });
  const freshConfig = JSON.parse(readFileSync(fresh, 'utf8'));
  assert.deepEqual(freshConfig.unrelated, { keep: true });
  assert.equal(statSync(fresh).mode & 0o777, 0o600);

  const rollback = join(dir, 'rollback.json');
  const original = '{\n    "unrelated": "preserve exact bytes"\n}\n';
  writeFileSync(rollback, original, { mode: 0o640 });
  let applies = 0;
  const result = await transactVoiceConfig(
    rollback,
    {
      unrelated: 'preserve exact bytes',
      stt: { provider: 'deepgram', apiKey: 'unit-placeholder-secret' },
    },
    'managed',
    async () => ({ ok: ++applies === 2 }),
  );
  assert.deepEqual(result, {
    ok: false,
    stage: 'apply',
    rolledBack: true,
    daemonRestored: true,
  });
  assert.equal(applies, 2, 'failed apply is followed by one restored-config apply');
  assert.equal(readFileSync(rollback, 'utf8'), original, 'rollback restores exact prior bytes');
  assert.equal(statSync(rollback).mode & 0o777, 0o640, 'rollback restores prior mode');

  const freshRollback = join(dir, 'fresh-rollback.json');
  let freshApplies = 0;
  const freshResult = await transactVoiceConfig(
    freshRollback,
    { stt: { provider: 'deepgram', apiKey: 'unit-placeholder-secret' } },
    'managed',
    async () => ({ ok: ++freshApplies === 2 }),
  );
  assert.equal(freshResult.ok, false);
  assert.equal(freshResult.rolledBack, true);
  assert.equal(freshResult.daemonRestored, true);
  assert.equal(existsSync(freshRollback), false, 'rollback removes a newly-created config');

  const rerun = join(dir, 'rerun.json');
  const rerunText = '{\n  "unrelated": true,\n  "stt": {\n    "provider": "deepgram",\n    "apiKey": "unit-placeholder-secret"\n  }\n}\n';
  writeFileSync(rerun, rerunText, { mode: 0o640 });
  let rerunOutput = '';
  const rerunCode = await runVoiceSetup({
    configFile: rerun,
    env: { OURS_ASSUME_YES: '1' },
    daemonState: 'managed',
    apply: () => {
      throw new Error('safe rerun must not restart');
    },
    stdout: (text) => {
      rerunOutput += text;
    },
  });
  assert.equal(rerunCode, 0);
  assert.match(rerunOutput, /already ready \(deepgram; API key from config\)/);
  assert.equal(readFileSync(rerun, 'utf8'), rerunText, 'headless safe rerun preserves exact bytes');
  assert.equal(statSync(rerun).mode & 0o777, 0o640, 'safe rerun does not rewrite or chmod');

  console.log('voice setup config: 18 passed');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
