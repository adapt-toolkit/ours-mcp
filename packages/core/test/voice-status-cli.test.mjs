import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'ours-voice-status-'));
const config = join(dir, 'config.json');
const cli = new URL('../dist/cli.js', import.meta.url);
const secret = 'status-placeholder-secret-123';

try {
  writeFileSync(config, JSON.stringify({
    stt: { provider: 'deepgram', apiKey: secret, model: 'nova-test' },
  }));
  const readyText = execFileSync(process.execPath, [cli.pathname, 'voice-status', '--json'], {
    env: { ...process.env, OURS_CONFIG: config },
    encoding: 'utf8',
  });
  const ready = JSON.parse(readyText);
  assert.equal(ready.ready, true);
  assert.equal(ready.provider, 'deepgram');
  assert.equal(ready.apiKey, 'configured');
  assert.equal(ready.keySource, 'config');
  assert.doesNotMatch(readyText, new RegExp(secret));

  writeFileSync(config, JSON.stringify({ stt: { provider: 'elevenlabs' } }));
  const missingText = execFileSync(process.execPath, [cli.pathname, 'stt-status', '--json'], {
    env: { ...process.env, OURS_CONFIG: config },
    encoding: 'utf8',
  });
  const missing = JSON.parse(missingText);
  assert.equal(missing.ready, false);
  assert.equal(missing.apiKey, 'missing');
  assert.match(missing.reason, /API key is missing/);

  console.log('voice-status CLI: 2 passed');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
