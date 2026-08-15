// Universal STT layer: per-adapter request-shape assertions against a local
// mock HTTP server, config-readiness statuses, and the three deterministic
// delivery lines. No daemon boot needed.
import { createServer } from 'node:http';
import {
  sttStatus, transcribeVoice, voiceDeliveryLine, structuredVoiceOutcome, textAtPath, baseMime,
} from '../dist/transcribe.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓', m)) : (fail++, console.log('  ✗ FAIL:', m)); };

// ---- mock provider server: records the last request, replies per-path ------
let last = null;
const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    last = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) };
    if (req.url.startsWith('/http401')) { res.writeHead(401); res.end('{"error":"bad key"}'); return; }
    if (req.url.startsWith('/echo-key')) {
      res.writeHead(401);
      res.end('provider rejected do-not-leak-placeholder');
      return;
    }
    if (req.url.startsWith('/slow')) return; // never responds → timeout path
    if (req.url.startsWith('/missing-text')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ unexpected: true }));
      return;
    }
    if (req.url.startsWith('/v1/listen')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ results: { channels: [{ alternatives: [{ transcript: 'dg text' }] }] } }));
      return;
    }
    if (req.url.startsWith('/nested')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: { items: [{ out: 'custom text' }] } }));
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ text: 'hello world' }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const VOICE_MIME = 'audio/mp4; x-ours-kind=voice-message';
const BYTES = Buffer.from('fake-audio-bytes');
const FNAME = 'voice-message-20260711-193210.m4a';

// ---- sttStatus: no defaults, precise reasons --------------------------------
{
  ok(!sttStatus(undefined).ready && sttStatus(undefined).reason.includes('no STT provider configured'), 'unset stt → not ready, names the provider field');
  ok(sttStatus({ provider: 'nope', apiKey: 'k' }).reason.includes('unknown STT provider'), 'unknown provider → precise reason');
  ok(sttStatus({ provider: 'elevenlabs' }).reason.includes('API key is missing'), 'missing key → precise reason');
  ok(sttStatus({ provider: 'openai-compatible', apiKey: 'k', model: 'm' }).reason.includes('baseUrl'), 'openai-compatible without baseUrl → not ready (no endpoint assumed)');
  ok(sttStatus({ provider: 'openai-compatible', apiKey: 'k', baseUrl: 'http://x' }).reason.includes('model'), 'openai-compatible without model → not ready (no model assumed)');
  ok(sttStatus({ provider: 'elevenlabs', apiKey: 'k' }).reason.includes('model'), 'elevenlabs without model → not ready');
  ok(sttStatus({ provider: 'deepgram', apiKey: 'k' }).ready, 'deepgram ready without model (provider-side default is the user\'s choice)');
  ok(sttStatus({ provider: 'custom', apiKey: 'k' }).reason.includes('custom.url'), 'custom without url → precise reason');
  ok(sttStatus({ provider: 'custom', apiKey: 'k', custom: { url: 'http://x/{model}' } }).reason.includes('model'), 'custom url with {model} but no model → not ready');
  ok(sttStatus({ provider: 'custom', apiKey: 'k', custom: { url: 'http://x', modelField: '' } }).ready, 'custom with modelField:"" (omit) → ready without model');
  ok(sttStatus({ provider: 'ElevenLabs', apiKey: 'k', model: 'scribe_v1' }).ready, 'provider name is case-insensitive');
}

// ---- openai-compatible adapter ----------------------------------------------
{
  const r = await transcribeVoice(BYTES, FNAME, VOICE_MIME, {
    provider: 'openai-compatible', apiKey: 'sk-test', model: 'whisper-large-v3-turbo', baseUrl: `${BASE}/v1`, language: 'ru',
  });
  ok(r.ok && r.text === 'hello world', 'openai-compatible: transcript returned');
  ok(last.url === '/v1/audio/transcriptions' && last.method === 'POST', 'openai-compatible: POST <base>/audio/transcriptions');
  ok(last.headers.authorization === 'Bearer sk-test', 'openai-compatible: Bearer auth');
  const body = last.body.toString('latin1');
  ok(body.includes('name="model"') && body.includes('whisper-large-v3-turbo'), 'openai-compatible: model field passes VERBATIM');
  ok(body.includes('name="language"') && body.includes('"ru"') || body.includes('ru'), 'openai-compatible: language hint sent');
  ok(body.includes(`filename="${FNAME}"`), 'openai-compatible: real filename in multipart');
  ok(body.includes('Content-Type: audio/mp4'), 'openai-compatible: REAL container mime on the file part (marker stripped)');
}

// ---- elevenlabs adapter -------------------------------------------------------
{
  const r = await transcribeVoice(BYTES, FNAME, VOICE_MIME, {
    provider: 'elevenlabs', apiKey: 'xi-test', model: 'scribe_v1', baseUrl: BASE,
  });
  ok(r.ok && r.text === 'hello world', 'elevenlabs: transcript returned');
  ok(last.url === '/v1/speech-to-text', 'elevenlabs: POST /v1/speech-to-text');
  ok(last.headers['xi-api-key'] === 'xi-test' && last.headers.authorization === undefined, 'elevenlabs: xi-api-key header, no Bearer');
  const body = last.body.toString('latin1');
  ok(body.includes('name="model_id"') && body.includes('scribe_v1'), 'elevenlabs: model_id field');
  ok(body.includes('Content-Type: audio/mp4'), 'elevenlabs: real container mime on the file part');
}

// ---- deepgram adapter ---------------------------------------------------------
{
  const r = await transcribeVoice(BYTES, FNAME, VOICE_MIME, {
    provider: 'deepgram', apiKey: 'dg-test', model: 'nova-2', baseUrl: BASE,
  });
  ok(r.ok && r.text === 'dg text', 'deepgram: transcript from results.channels[0].alternatives[0]');
  ok(last.url === '/v1/listen?model=nova-2', 'deepgram: model as query param');
  ok(last.headers.authorization === 'Token dg-test', 'deepgram: Token auth scheme');
  ok(last.headers['content-type'] === 'audio/mp4', 'deepgram: raw body with REAL container mime (marker stripped)');
  ok(last.body.equals(BYTES), 'deepgram: raw bytes uploaded unmodified');
}

// ---- custom template adapter ---------------------------------------------------
{
  const r = await transcribeVoice(BYTES, FNAME, VOICE_MIME, {
    provider: 'custom', apiKey: 'K123', model: 'my-model',
    custom: {
      url: `${BASE}/nested/{model}`,
      authHeaderName: 'x-secret',
      authHeaderTemplate: 'key {key}',
      bodyMode: 'json-base64',
      fileField: 'audio_b64',
      modelField: 'mdl',
      extraFields: { fmt: 'json' },
      responseTextPath: 'data.items.0.out',
    },
  });
  ok(r.ok && r.text === 'custom text', 'custom: transcript via responseTextPath dot-path (with array index)');
  ok(last.url === '/nested/my-model', 'custom: {model} substituted into url');
  ok(last.headers['x-secret'] === 'key K123', 'custom: templated auth header');
  const j = JSON.parse(last.body.toString());
  ok(j.audio_b64 === BYTES.toString('base64') && j.mdl === 'my-model' && j.fmt === 'json', 'custom: json-base64 body with mapped + extra fields');

  const raw = await transcribeVoice(BYTES, FNAME, VOICE_MIME, {
    provider: 'custom', apiKey: 'K123',
    custom: { url: `${BASE}/anything`, bodyMode: 'raw', modelField: '' },
  });
  ok(raw.ok, 'custom raw mode works');
  ok(last.headers['content-type'] === 'audio/mp4' && last.body.equals(BYTES), 'custom raw: real mime + unmodified bytes');
}

// ---- failure paths: never throw, precise errors ---------------------------------
{
  const r401 = await transcribeVoice(BYTES, FNAME, VOICE_MIME, {
    provider: 'openai-compatible', apiKey: 'bad', model: 'm', baseUrl: `${BASE}/http401`,
  });
  ok(!r401.ok && r401.error.includes('401'), '401 → {ok:false} with status in error');

  const rTimeout = await transcribeVoice(BYTES, FNAME, VOICE_MIME, {
    provider: 'openai-compatible', apiKey: 'k', model: 'm', baseUrl: `${BASE}/slow`, timeoutMs: 300,
  });
  ok(!rTimeout.ok && rTimeout.error.includes('timeout'), 'timeout → {ok:false} with timeout error');

  const rBig = await transcribeVoice(Buffer.alloc(10), FNAME, VOICE_MIME, {
    provider: 'deepgram', apiKey: 'k', maxBytes: 5,
  });
  ok(!rBig.ok && rBig.error.includes('limit'), 'over maxBytes → {ok:false} size-guard error, no request made');

  const rConn = await transcribeVoice(BYTES, FNAME, VOICE_MIME, {
    provider: 'openai-compatible', apiKey: 'k', model: 'm', baseUrl: 'http://127.0.0.1:1/v1',
  });
  ok(!rConn.ok, 'connection refused → {ok:false}, never throws');

  const rMalformed = await transcribeVoice(BYTES, FNAME, VOICE_MIME, {
    provider: 'openai-compatible', apiKey: 'k', model: 'm', baseUrl: `${BASE}/missing-text`,
  });
  ok(!rMalformed.ok && rMalformed.error.includes('missing text'), 'malformed provider response → explicit failure, never a blank transcript');

  const secret = 'do-not-leak-placeholder';
  const rEcho = await transcribeVoice(BYTES, 'voice_705.ogg', 'audio/ogg; x-ours-kind=voice-message', {
    provider: 'openai-compatible', apiKey: secret, model: 'm', baseUrl: `${BASE}/echo-key`,
  });
  ok(!rEcho.ok && rEcho.error.includes('[redacted]') && !rEcho.error.includes(secret), 'provider error body cannot echo the API key into diagnostics');
}

// ---- deterministic delivery lines ------------------------------------------------
{
  const args = { sender: 'Sam', wire: 'W1', savedPath: '/x/W1-v.m4a', sizeBytes: 42 };
  const t = voiceDeliveryLine(args, { kind: 'transcript', text: 'hi there' });
  ok(t.includes('🎤 voice message from Sam') && t.includes('"hi there"') && t.includes('transcribed from voice message') && t.includes('/x/W1-v.m4a') && t.includes('{W1}'), 'transcript line: text + provenance + saved path + wire id');
  const u = voiceDeliveryLine(args, { kind: 'unconfigured', reason: 'no STT provider configured (stt.provider…)' });
  ok(u.includes('cannot transcribe') && u.includes("Tell the user you can't listen to voice messages") && u.includes('audio saved →'), 'unconfigured line: agent-tells-user instruction + saved path');
  const f = voiceDeliveryLine(args, { kind: 'failed', error: 'STT HTTP 401' });
  ok(f.includes('transcription failed (STT HTTP 401)') && f.includes('Tell the user') && f.includes('audio saved →'), 'failed line: never silent, reason + saved path');
}

// ---- stable structured outcomes (no provider diagnostics/secrets) -----------
{
  const assoc = { audioPath: '/safe/W1-v.m4a', wireId: 'W1' };
  const ready = sttStatus({ provider: 'deepgram', apiKey: 'secret' });
  const success = structuredVoiceOutcome(ready, { kind: 'transcript', text: 'machine text' }, assoc);
  ok(success.status === 'succeeded' && success.configured && success.attempted && success.provider === 'deepgram'
    && success.text === 'machine text' && success.audio_path === assoc.audioPath && success.file_wire_id === 'W1',
  'structured transcript: success/provider/text/audio association');
  const failure = structuredVoiceOutcome(ready, { kind: 'failed', error: 'STT HTTP 401: secret provider detail' }, assoc);
  ok(failure.status === 'failed' && failure.error_category === 'provider_http' && failure.text === null
    && !JSON.stringify(failure).includes('secret provider detail'),
  'structured transcript: categorized failure omits provider diagnostics/secrets');
  const unavailableStatus = sttStatus(undefined);
  const unavailable = structuredVoiceOutcome(unavailableStatus, { kind: 'unconfigured', reason: unavailableStatus.reason }, assoc);
  ok(unavailable.status === 'unavailable' && !unavailable.configured && !unavailable.attempted
    && unavailable.provider === null && unavailable.error_category === 'not_configured',
  'structured transcript: explicit unconfigured fallback');
}

// ---- helpers ------------------------------------------------------------------
ok(baseMime('audio/webm; x-ours-kind=voice-message') === 'audio/webm', 'baseMime strips the marker');
ok(textAtPath({ a: [{ b: 'z' }] }, 'a.0.b') === 'z', 'textAtPath indexes arrays');

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
