// Unit tests for the installer's pure decision logic (no I/O, no subprocess) — fast + hermetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonHarnesses, suggestPort, parsePort, validateBroker, mergeConfig, parseVersion, parseStatus,
  detectPlatform, classifyHarnessProbe, buildHandoffPrompt,
  effectiveVoiceConfig, voiceSetupStatus, validateVoiceSecret, redactSensitive,
  DEFAULT_PORT, DEFAULT_BROKER, RESERVED_PORTS,
  resolveChannel, isNightlyVersion, pkgTag, pkgSpec, DEFAULT_CHANNEL,
} from '../lib/logic.mjs';

test('resolveChannel: nightly synonyms → nightly; everything else → latest', () => {
  assert.equal(DEFAULT_CHANNEL, 'latest');
  assert.equal(resolveChannel('nightly'), 'nightly');
  assert.equal(resolveChannel('NIGHTLY'), 'nightly');
  assert.equal(resolveChannel('prerelease'), 'nightly');
  assert.equal(resolveChannel('next'), 'nightly');
  assert.equal(resolveChannel('latest'), 'latest');
  assert.equal(resolveChannel(''), 'latest');
  assert.equal(resolveChannel(undefined), 'latest');
  assert.equal(resolveChannel('garbage'), 'latest', 'unknown never guesses a tag');
});

test('resolveChannel: a published installer follows its own channel when env is silent', () => {
  assert.equal(resolveChannel(undefined, '0.17.0'), 'latest');
  assert.equal(resolveChannel('', '0.18.0-nightly.3'), 'nightly');
  assert.equal(resolveChannel(undefined, '0.18.0-nightly.42'), 'nightly');
  assert.equal(resolveChannel('latest', '0.18.0-nightly.3'), 'latest', 'explicit stable override still wins');
  assert.equal(resolveChannel('nightly', '0.17.0'), 'nightly', 'explicit nightly override still wins');
  assert.equal(resolveChannel('garbage', '0.18.0-nightly.3'), 'latest', 'unknown override fails safe to stable');
});

test('isNightlyVersion recognizes only the release workflow suffix', () => {
  assert.equal(isNightlyVersion('0.18.0-nightly.3'), true);
  assert.equal(isNightlyVersion('1.2.3-nightly.42'), true);
  assert.equal(isNightlyVersion('0.18.0'), false);
  assert.equal(isNightlyVersion('0.18.0-rc.1'), false);
  assert.equal(isNightlyVersion('0.18.0-nightly.03'), false);
});

test('pkgTag: nightly channel tags mcp/tg/plugins @nightly but fleet ALWAYS @latest', () => {
  // Nightly channel → nightly for the channel-tracking packages.
  assert.equal(pkgTag('mcp', 'nightly'), 'nightly');
  assert.equal(pkgTag('tg-connector', 'nightly'), 'nightly');
  assert.equal(pkgTag('claude-code', 'nightly'), 'nightly');
  assert.equal(pkgTag('codex', 'nightly'), 'nightly');
  assert.equal(pkgTag('hermes', 'nightly'), 'nightly');
  // fleet is pinned — it has no nightly tag.
  assert.equal(pkgTag('fleet', 'nightly'), 'latest', 'fleet stays stable even in nightly');
  // Latest channel → everything latest.
  assert.equal(pkgTag('mcp', 'latest'), 'latest');
  assert.equal(pkgTag('fleet', 'latest'), 'latest');
  // Accepts the fully-qualified name too.
  assert.equal(pkgTag('@ours.network/mcp', 'nightly'), 'nightly');
  assert.equal(pkgTag('@ours.network/fleet', 'nightly'), 'latest');
});

test('pkgSpec: builds the full npm spec honoring the channel + fleet pin', () => {
  assert.equal(pkgSpec('mcp', 'nightly'), '@ours.network/mcp@nightly');
  assert.equal(pkgSpec('tg-connector', 'nightly'), '@ours.network/tg-connector@nightly');
  assert.equal(pkgSpec('codex', 'nightly'), '@ours.network/codex@nightly');
  assert.equal(pkgSpec('fleet', 'nightly'), '@ours.network/fleet@latest', 'fleet NEVER @nightly');
  assert.equal(pkgSpec('mcp', 'latest'), '@ours.network/mcp@latest');
  assert.equal(pkgSpec('fleet'), '@ours.network/fleet@latest', 'default channel = latest');
});

test('canonHarnesses: names/numbers/all, de-duped and order-preserving; OpenClaw is gone', () => {
  assert.deepEqual(canonHarnesses('codex hermes').names, ['codex', 'hermes']);
  assert.deepEqual(canonHarnesses('2,3').names, ['codex', 'hermes']);
  assert.deepEqual(canonHarnesses('cc codex codex').names, ['claude-code', 'codex']);
  assert.deepEqual(canonHarnesses('all').names, ['claude-code', 'codex', 'hermes']);
  assert.deepEqual(canonHarnesses('none').names, []);
  // OpenClaw support was removed — the token is unknown now, never a selection.
  const r = canonHarnesses('openclaw hermes');
  assert.deepEqual(r.names, ['hermes']);
  assert.deepEqual(r.unknown, ['openclaw']);
});

test('suggestPort: keeps a free port, avoids reserved 3051, and skips taken ports', () => {
  const free = () => false;
  assert.equal(suggestPort(3050, free), 3050, 'free desired kept');
  assert.equal(suggestPort(3051, free), 3060, 'reserved 3051 → first free alternate ≥3060');
  assert.notEqual(suggestPort(3051, free), 3051, 'never returns the reserved port');
  // 3050 taken → alternate from 3060 up; 3060 taken too → 3061.
  const taken = (p) => p === 3050 || p === 3060;
  assert.equal(suggestPort(3050, taken), 3061);
  assert.ok(!RESERVED_PORTS.includes(suggestPort(3051, () => true)) || suggestPort(3051, () => true) === 3051 /* exhausted */);
});

test('parsePort: validates range, falls back otherwise', () => {
  assert.deepEqual(parsePort('3060'), { ok: true, port: 3060 });
  assert.deepEqual(parsePort('  8080 '), { ok: true, port: 8080 });
  assert.deepEqual(parsePort('nope', 3050), { ok: false, port: 3050 });
  assert.deepEqual(parsePort('70000', 3050), { ok: false, port: 3050 });
  assert.deepEqual(parsePort('0', 3050), { ok: false, port: 3050 });
});

test('validateBroker: accepts ws/wss, flags junk, treats empty as keep-default', () => {
  assert.deepEqual(validateBroker('wss://broker1.ours.network'), { ok: true, value: 'wss://broker1.ours.network', empty: false });
  assert.equal(validateBroker('ws://localhost:9000').ok, true);
  assert.equal(validateBroker('http://nope').ok, false);
  assert.deepEqual(validateBroker('   '), { ok: true, value: '', empty: true });
});

test('mergeConfig: patches only given keys, preserves the rest, trailing newline', () => {
  const out = mergeConfig({ stateDir: '/x', port: 3050 }, { port: 3060, brokerUrl: 'wss://b' });
  const obj = JSON.parse(out);
  assert.equal(obj.stateDir, '/x', 'unrelated key preserved');
  assert.equal(obj.port, 3060, 'patched');
  assert.equal(obj.brokerUrl, 'wss://b', 'added');
  assert.ok(out.endsWith('\n'), 'trailing newline');
  // undefined patch values are ignored, not written.
  assert.equal(JSON.parse(mergeConfig({}, { port: undefined })).port, undefined);
});

test('voice readiness is capability-based, env-overridable, and never returns a key', () => {
  assert.equal(voiceSetupStatus({}).ready, false);
  assert.deepEqual(voiceSetupStatus({ stt: { provider: 'deepgram' } }).missing, ['apiKey']);
  assert.equal(voiceSetupStatus({ stt: { provider: 'deepgram', apiKey: 'placeholder-key' } }).ready, true);
  assert.equal(voiceSetupStatus({
    stt: { provider: 'openai-compatible', apiKey: 'placeholder-key', model: 'whisper-x' },
  }).missing[0], 'baseUrl');
  assert.equal(voiceSetupStatus({
    stt: { provider: 'elevenlabs', apiKey: 'placeholder-key' },
  }).missing[0], 'model');
  assert.equal(voiceSetupStatus({
    stt: { provider: 'custom', apiKey: 'placeholder-key', custom: { url: 'https://stt.invalid/{model}' } },
  }).missing[0], 'model');

  const env = {
    OURS_STT_PROVIDER: 'deepgram',
    OURS_STT_API_KEY: 'environment-placeholder-key',
    OURS_STT_MODEL: 'nova-test',
  };
  const effective = effectiveVoiceConfig({ stt: { provider: 'nope', apiKey: 'file-placeholder' } }, env);
  assert.equal(effective.provider, 'deepgram');
  const status = voiceSetupStatus({ stt: {} }, env);
  assert.equal(status.ready, true);
  assert.equal(status.keySource, 'environment');
  assert.doesNotMatch(JSON.stringify(status), /environment-placeholder-key|file-placeholder/);
});

test('voice secret validation is provider-neutral but rejects missing/malformed input', () => {
  assert.equal(validateVoiceSecret('').ok, false);
  assert.equal(validateVoiceSecret('short').ok, false);
  assert.equal(validateVoiceSecret('has whitespace').ok, false);
  assert.equal(validateVoiceSecret('placeholder-key-123').ok, true);
});

test('secret redaction removes exact values and common keyed diagnostics', () => {
  const secret = 'placeholder-secret-123';
  const scrubbed = redactSensitive(
    `provider echoed ${secret}; {"apiKey":"${secret}"} token=${secret}`,
    [secret],
  );
  assert.doesNotMatch(scrubbed, new RegExp(secret));
  assert.match(scrubbed, /\[redacted\]/);
});

test('parseVersion / parseStatus: pull versions + resolved broker/port out of CLI output', () => {
  assert.equal(parseVersion('ours-mcp v0.9.9'), '0.9.9');
  assert.equal(parseVersion('ours-mcp v0.18.0-nightly.3'), '0.18.0-nightly.3', 'channel switches remain restart-visible');
  assert.equal(parseVersion('nothing here'), '');
  const st = parseStatus([
    'ours-mcp: running',
    '  url:    http://localhost:3070/mcp (reachable)',
    '  broker: wss://broker1.ours.network',
  ].join('\n'));
  assert.equal(st.broker, 'wss://broker1.ours.network');
  assert.equal(st.port, 3070);
  assert.deepEqual(parseStatus('ours-mcp: stopped'), { broker: null, port: null });
});

test('defaults mirror the daemon core config', () => {
  assert.equal(DEFAULT_PORT, 3050);
  assert.equal(DEFAULT_BROKER, 'wss://broker1.ours.network');
});

// --- v2 unified-installer logic ----------------------------------------------------------------

test('detectPlatform: macOS/Linux/WSL supported, native Windows not, unknown not', () => {
  assert.deepEqual(detectPlatform({ platform: 'darwin' }), { os: 'macos', label: 'macOS', supported: true });
  assert.deepEqual(detectPlatform({ platform: 'linux', release: '6.5.0-generic' }), { os: 'linux', label: 'Linux', supported: true });
  // WSL by kernel release string…
  assert.equal(detectPlatform({ platform: 'linux', release: '5.15.0-microsoft-standard-WSL2' }).os, 'wsl');
  // …or by the WSL env markers.
  assert.equal(detectPlatform({ platform: 'linux', release: '6.5.0', env: { WSL_DISTRO_NAME: 'Ubuntu' } }).os, 'wsl');
  assert.equal(detectPlatform({ platform: 'win32' }).supported, false);
  assert.equal(detectPlatform({ platform: 'win32' }).os, 'windows');
  assert.equal(detectPlatform({ platform: 'sunos' }).supported, false);
});

test('classifyHarnessProbe: real binary ok; hang/alias/function never dead-end; absent skipped', () => {
  assert.equal(classifyHarnessProbe({ onPath: true, versionOk: true }).status, 'ok');
  // A wrapper that never answered --version had to be killed → treat as unsafe alias, never call it.
  assert.equal(classifyHarnessProbe({ onPath: true, versionOk: false, timedOut: true }).status, 'alias');
  // Shadowed by a shell alias/function even when no real binary is on PATH.
  assert.equal(classifyHarnessProbe({ onPath: false, shellType: 'alias' }).status, 'alias');
  assert.equal(classifyHarnessProbe({ onPath: false, shellType: 'function' }).status, 'alias');
  // On PATH but the probe just didn't look right → don't auto-drive, still offer a manual path.
  assert.equal(classifyHarnessProbe({ onPath: true, versionOk: false, shellType: 'file' }).status, 'unsafe');
  // Genuinely not there.
  assert.equal(classifyHarnessProbe({ onPath: false, versionOk: false, shellType: '' }).status, 'absent');
});

test('buildHandoffPrompt: identity is a fallback step; fleet/telegram drop out; empty when nothing left', () => {
  // Identity fallback (in-install creation failed/skipped) → step 1 uses the "human identity"
  // wording: capital "Ours", no "root" jargon (the CLI seam stays create-root, copy never says root).
  const all = buildHandoffPrompt({ identity: true, fleet: true, telegram: true }).text;
  assert.match(all, /1\. Create my Ours human identity/);
  assert.match(all, /my agents act on\s+my behalf/);
  assert.doesNotMatch(all, /root/i, 'user-facing hand-off must not use the "root" jargon');
  // Fleet step: stand up a PERMANENT team, not a temp-agent demo.
  assert.match(all, /2\. Set up my ours-fleet/);
  assert.match(all, /PERMANENT use/);
  assert.doesNotMatch(all, /temporary agent/, 'fleet step must not demo a temporary agent');
  assert.match(all, /3\. Set up my Telegram bot/);

  // Identity already created in-install → its step drops; remaining steps renumber.
  const noId = buildHandoffPrompt({ fleet: true, telegram: true }).text;
  assert.doesNotMatch(noId, /human identity/i, 'identity created in-install drops out of the hand-off');
  assert.match(noId, /1\. Set up my ours-fleet/);
  assert.match(noId, /2\. Set up my Telegram bot/);

  const fleetOnly = buildHandoffPrompt({ fleet: true }).text;
  assert.match(fleetOnly, /1\. Set up my ours-fleet/);
  assert.doesNotMatch(fleetOnly, /Telegram/, 'a skipped Telegram must not appear in the hand-off');

  // Everything done in-install (identity created, no fleet/telegram) → nothing to hand off.
  const done = buildHandoffPrompt({});
  assert.equal(done.empty, true);
  assert.equal(done.text, '');
});
