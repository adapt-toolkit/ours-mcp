// packages/core/src/transcribe.ts
//
// Voice-message detection + universal STT transcription for incoming files.
//
// Voice messages are a DISTINCT file type, not generic audio: the panel-side
// recorder marks them explicitly in the mime string, and the `mime` set by the
// sender travels verbatim through ::a2a_messaging::send_file to the receiving
// wrapper (handle_receive_file leaves it untouched) — so detection is
// deterministic and needs no protocol change. Music/podcast/etc. audio without
// the marker is never treated as a voice message.
//
// Transcription is provider-agnostic and has NO baked default provider or
// model: it stays off until the operator configures stt.provider + stt.apiKey
// (+ model where the provider requires one). Named adapters cover the common
// API shapes; the `custom` adapter is a fully-configurable request template so
// any other provider plugs in via config alone. Zero npm dependencies — bare
// fetch/FormData/Blob, mirroring the telegram-connector's stt.ts (same guard
// semantics, degrade-not-crash, never log the key).

// ----- detection ---------------------------------------------------------------
//
// MARKER (locked with Designer-1, 2026-07-11): the panel emits
//   <base>; x-ours-kind=voice-message
// where <base> is the REAL recorded container and VARIES by browser:
// audio/mp4 (iOS Safari — MediaRecorder there only does mp4), audio/webm
// (Chrome/Android opus), audio/ogg (rare fallback). Match on the parameter,
// never on the base type. The real base mime is passed through to the STT
// upload (whisper-class APIs accept m4a/mp4/webm/ogg).

/**
 * The exact mime parameter the panel puts on voice messages.
 * SINGLE SOURCE OF TRUTH — any change must be coordinated with the panel send
 * side (Designer-1); swapping it is a one-line change here.
 */
export const VOICE_MESSAGE_MIME_PARAM = 'x-ours-kind=voice-message';

/**
 * Fallback marker (also panel-controlled): filename `voice-message-<UTCstamp>.<ext>`
 * — only honoured when the base mime is audio/*.
 */
export const VOICE_MESSAGE_FILENAME_PREFIX = 'voice-message-';

/**
 * Deterministic voice-message check for an incoming file.
 * PRIMARY: case-insensitive `x-ours-kind=voice-message` among the mime
 * parameters. FALLBACK: filename starts with `voice-message-` AND the base
 * type is audio/*.
 */
export function isVoiceMessage(mime: string, filename: string): boolean {
  const parts = (mime ?? '').toLowerCase().split(';').map(p => p.trim());
  if (parts[0].startsWith('audio/') && parts.slice(1).includes(VOICE_MESSAGE_MIME_PARAM)) return true;
  return (
    filename.toLowerCase().startsWith(VOICE_MESSAGE_FILENAME_PREFIX) &&
    parts[0].startsWith('audio/')
  );
}

/** The real container type, with our marker (and any other params) stripped. */
export function baseMime(mime: string): string {
  return (mime ?? '').split(';')[0].trim() || 'application/octet-stream';
}

// ----- configuration -------------------------------------------------------------

export const STT_PROVIDERS = ['openai-compatible', 'elevenlabs', 'deepgram', 'custom'] as const;
export type SttProvider = (typeof STT_PROVIDERS)[number];

/** Request template for `provider: "custom"` — plugs in ANY provider via config. */
export interface SttCustomTemplate {
  /** Full endpoint URL; `{model}` is substituted when set. */
  url: string;
  /** HTTP method (default POST). */
  method?: string;
  /** Auth header name (default Authorization). */
  authHeaderName?: string;
  /** Auth header value; `{key}` is substituted (default `Bearer {key}`). */
  authHeaderTemplate?: string;
  /** How the audio travels (default multipart). */
  bodyMode?: 'multipart' | 'raw' | 'json-base64';
  /** Multipart / JSON field carrying the audio (default `file`). */
  fileField?: string;
  /** Field carrying the model; empty string = omit the field (default `model`). */
  modelField?: string;
  /** Extra constant fields to send alongside. */
  extraFields?: Record<string, string>;
  /** Dot-path to the transcript in the JSON response (default `text`); numeric segments index arrays. */
  responseTextPath?: string;
}

/** User-facing config block (config.json `stt: {}` / OURS_STT_* env). No defaults for provider/model/key. */
export interface SttUserConfig {
  provider?: string;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  language?: string;
  maxBytes?: number;
  timeoutMs?: number;
  custom?: SttCustomTemplate;
}

export const STT_MAX_BYTES_DEFAULT = 5 * 1024 * 1024; // guard, same as tg-connector
export const STT_TIMEOUT_MS_DEFAULT = 60_000;

export type SttStatus =
  | { ready: true; provider: SttProvider }
  | { ready: false; reason: string };

/**
 * Deterministic readiness check with a PRECISE operator-facing reason when not
 * configured. Partial configuration never guesses.
 */
export function sttStatus(cfg: SttUserConfig | undefined): SttStatus {
  const hint = 'configure it in config.json `stt: {}` or via OURS_STT_* env';
  if (!cfg?.provider) {
    return { ready: false, reason: `no STT provider configured (stt.provider: ${STT_PROVIDERS.join(' | ')}) — ${hint}` };
  }
  const provider = cfg.provider.trim().toLowerCase() as SttProvider;
  if (!(STT_PROVIDERS as readonly string[]).includes(provider)) {
    return { ready: false, reason: `unknown STT provider "${cfg.provider}" (expected: ${STT_PROVIDERS.join(' | ')})` };
  }
  if (!cfg.apiKey?.trim()) {
    return { ready: false, reason: `STT provider "${provider}" is set but the API key is missing (stt.apiKey / OURS_STT_API_KEY)` };
  }
  if (provider === 'openai-compatible') {
    if (!cfg.baseUrl?.trim()) {
      return { ready: false, reason: 'openai-compatible STT needs stt.baseUrl / OURS_STT_BASE_URL (e.g. your provider\'s /v1 root) — no endpoint is assumed' };
    }
    if (!cfg.model?.trim()) {
      return { ready: false, reason: 'openai-compatible STT needs stt.model / OURS_STT_MODEL (passed to the provider verbatim) — no model is assumed' };
    }
  }
  if (provider === 'elevenlabs' && !cfg.model?.trim()) {
    return { ready: false, reason: 'elevenlabs STT needs stt.model / OURS_STT_MODEL (the model_id, e.g. from your ElevenLabs account) — no model is assumed' };
  }
  if (provider === 'custom') {
    if (!cfg.custom?.url?.trim()) {
      return { ready: false, reason: 'custom STT needs stt.custom.url (the full endpoint URL of your provider)' };
    }
    const wantsModel =
      cfg.custom.url.includes('{model}') ||
      (cfg.custom.modelField !== undefined && cfg.custom.modelField !== '');
    if (wantsModel && !cfg.model?.trim()) {
      return { ready: false, reason: 'the custom STT template references a model (url {model} or modelField) but stt.model / OURS_STT_MODEL is not set' };
    }
  }
  return { ready: true, provider };
}

// ----- transcription -------------------------------------------------------------

export type SttResult = { ok: true; text: string } | { ok: false; error: string };

/** Dot-path lookup; numeric segments index arrays ("results.channels.0.…"). */
export function textAtPath(obj: unknown, path: string): string | undefined {
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return typeof cur === 'string' ? cur : undefined;
}

async function request(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  secrets: string[] = [],
): Promise<{ ok: true; json: unknown } | { ok: false; error: string }> {
  const aborter = new AbortController();
  const timer = setTimeout(() => aborter.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...init, signal: aborter.signal });
    if (!resp.ok) {
      let detail = await resp.text().catch(() => '');
      for (const secret of secrets) {
        if (secret) detail = detail.split(secret).join('[redacted]');
      }
      return { ok: false, error: `STT HTTP ${resp.status}${detail ? `: ${detail.slice(0, 200)}` : ''}` };
    }
    return { ok: true, json: await resp.json() };
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') {
      return { ok: false, error: `STT timeout after ${timeoutMs}ms` };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

const audioBlob = (bytes: Buffer, mime: string): Blob =>
  // Copy into a plain Uint8Array — a Buffer is not a valid BlobPart.
  new Blob([new Uint8Array(bytes)], { type: baseMime(mime) });

type Adapter = (bytes: Buffer, filename: string, mime: string, cfg: SttUserConfig, timeoutMs: number) => Promise<SttResult>;

const openaiCompatible: Adapter = async (bytes, filename, mime, cfg, timeoutMs) => {
  const form = new FormData();
  form.set('file', audioBlob(bytes, mime), filename);
  form.set('model', cfg.model!.trim());
  form.set('response_format', 'json');
  if (cfg.language?.trim()) form.set('language', cfg.language.trim());
  const r = await request(
    `${cfg.baseUrl!.trim().replace(/\/$/, '')}/audio/transcriptions`,
    { method: 'POST', headers: { Authorization: `Bearer ${cfg.apiKey!.trim()}` }, body: form },
    timeoutMs,
    [cfg.apiKey!.trim()],
  );
  if (!r.ok) return r;
  const text = textAtPath(r.json, 'text');
  return text !== undefined ? { ok: true, text } : { ok: false, error: 'STT response missing text' };
};

const elevenlabs: Adapter = async (bytes, filename, mime, cfg, timeoutMs) => {
  const form = new FormData();
  form.set('file', audioBlob(bytes, mime), filename);
  form.set('model_id', cfg.model!.trim());
  if (cfg.language?.trim()) form.set('language_code', cfg.language.trim());
  const r = await request(
    `${(cfg.baseUrl?.trim() || 'https://api.elevenlabs.io').replace(/\/$/, '')}/v1/speech-to-text`,
    { method: 'POST', headers: { 'xi-api-key': cfg.apiKey!.trim() }, body: form },
    timeoutMs,
    [cfg.apiKey!.trim()],
  );
  if (!r.ok) return r;
  const text = textAtPath(r.json, 'text');
  return text !== undefined ? { ok: true, text } : { ok: false, error: 'STT response missing text' };
};

const deepgram: Adapter = async (bytes, _filename, mime, cfg, timeoutMs) => {
  const params = new URLSearchParams();
  if (cfg.model?.trim()) params.set('model', cfg.model.trim());
  if (cfg.language?.trim()) params.set('language', cfg.language.trim());
  const q = params.toString();
  const r = await request(
    `${(cfg.baseUrl?.trim() || 'https://api.deepgram.com').replace(/\/$/, '')}/v1/listen${q ? `?${q}` : ''}`,
    {
      method: 'POST',
      headers: { Authorization: `Token ${cfg.apiKey!.trim()}`, 'Content-Type': baseMime(mime) },
      body: new Uint8Array(bytes),
    },
    timeoutMs,
    [cfg.apiKey!.trim()],
  );
  if (!r.ok) return r;
  const text = textAtPath(r.json, 'results.channels.0.alternatives.0.transcript');
  return text !== undefined ? { ok: true, text } : { ok: false, error: 'STT response missing transcript' };
};

const custom: Adapter = async (bytes, filename, mime, cfg, timeoutMs) => {
  const t = cfg.custom!;
  const model = cfg.model?.trim() ?? '';
  const url = t.url.replaceAll('{model}', encodeURIComponent(model));
  const headers: Record<string, string> = {};
  const authName = t.authHeaderName?.trim() || 'Authorization';
  const authValue = (t.authHeaderTemplate ?? 'Bearer {key}').replaceAll('{key}', cfg.apiKey!.trim());
  if (authValue) headers[authName] = authValue;

  const mode = t.bodyMode ?? 'multipart';
  const fileField = t.fileField?.trim() || 'file';
  const modelField = t.modelField === undefined ? 'model' : t.modelField.trim();
  let body: BodyInit;
  if (mode === 'multipart') {
    const form = new FormData();
    form.set(fileField, audioBlob(bytes, mime), filename);
    if (modelField && model) form.set(modelField, model);
    for (const [k, v] of Object.entries(t.extraFields ?? {})) form.set(k, v);
    body = form;
  } else if (mode === 'raw') {
    headers['Content-Type'] = baseMime(mime);
    body = new Uint8Array(bytes);
  } else {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify({
      [fileField]: bytes.toString('base64'),
      ...(modelField && model ? { [modelField]: model } : {}),
      ...(t.extraFields ?? {}),
    });
  }
  const r = await request(url, { method: t.method?.trim() || 'POST', headers, body }, timeoutMs, [cfg.apiKey!.trim()]);
  if (!r.ok) return r;
  const text = textAtPath(r.json, t.responseTextPath?.trim() || 'text');
  return text !== undefined
    ? { ok: true, text }
    : { ok: false, error: `STT response has no text at "${t.responseTextPath?.trim() || 'text'}"` };
};

const ADAPTERS: Record<SttProvider, Adapter> = {
  'openai-compatible': openaiCompatible,
  elevenlabs,
  deepgram,
  custom,
};

/**
 * Transcribe a voice message. Callers must have checked sttStatus().ready.
 * Never throws; never logs the key.
 */
export async function transcribeVoice(
  bytes: Buffer,
  filename: string,
  mime: string,
  cfg: SttUserConfig,
): Promise<SttResult> {
  const status = sttStatus(cfg);
  if (!status.ready) return { ok: false, error: status.reason };
  const maxBytes = cfg.maxBytes ?? STT_MAX_BYTES_DEFAULT;
  if (bytes.length > maxBytes) {
    return { ok: false, error: `voice message is ${bytes.length} B — over the ${maxBytes} B STT limit (stt.maxBytes)` };
  }
  const timeoutMs = cfg.timeoutMs ?? STT_TIMEOUT_MS_DEFAULT;
  try {
    return await ADAPTERS[status.provider](bytes, filename, mime, cfg, timeoutMs);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ----- deterministic delivery lines ------------------------------------------------
//
// The wrapper (writeIncomingFiles in index.ts) delivers voice messages to the
// agent as TEXT via exactly one of these three lines. The agent never touches
// audio; the original file is always saved and its path always included.

export type VoiceOutcome =
  | { kind: 'transcript'; text: string }
  | { kind: 'unconfigured'; reason: string }
  | { kind: 'failed'; error: string };

export type StructuredVoiceOutcome = {
  configured: boolean;
  attempted: boolean;
  status: 'succeeded' | 'failed' | 'unavailable';
  provider: SttProvider | null;
  text: string | null;
  error_category: 'not_configured' | 'size_limit' | 'timeout' | 'provider_http' | 'invalid_response' | 'provider_error' | null;
  audio_path: string;
  file_wire_id: string;
};

function voiceErrorCategory(error: string): Exclude<StructuredVoiceOutcome['error_category'], 'not_configured' | null> {
  if (/limit|over .* bytes/i.test(error)) return 'size_limit';
  if (/timeout/i.test(error)) return 'timeout';
  if (/HTTP \d+/i.test(error)) return 'provider_http';
  if (/missing|no text|no transcript/i.test(error)) return 'invalid_response';
  return 'provider_error';
}

/** Stable, secret-free machine view paired with the existing human delivery line. */
export function structuredVoiceOutcome(
  readiness: SttStatus,
  outcome: VoiceOutcome,
  association: { audioPath: string; wireId: string },
): StructuredVoiceOutcome {
  if (!readiness.ready || outcome.kind === 'unconfigured') {
    return {
      configured: false, attempted: false, status: 'unavailable', provider: null,
      text: null, error_category: 'not_configured', audio_path: association.audioPath,
      file_wire_id: association.wireId,
    };
  }
  if (outcome.kind === 'transcript') {
    return {
      configured: true, attempted: true, status: 'succeeded', provider: readiness.provider,
      text: outcome.text, error_category: null, audio_path: association.audioPath,
      file_wire_id: association.wireId,
    };
  }
  return {
    configured: true, attempted: true, status: 'failed', provider: readiness.provider,
    text: null, error_category: voiceErrorCategory(outcome.error), audio_path: association.audioPath,
    file_wire_id: association.wireId,
  };
}

export function voiceDeliveryLine(
  args: { sender: string; wire: string; savedPath: string; sizeBytes: number },
  outcome: VoiceOutcome,
): string {
  const head = `  • 🎤 voice message from ${args.sender} (${args.sizeBytes} B)`;
  const tail = `audio saved → ${args.savedPath} {${args.wire}}`;
  switch (outcome.kind) {
    case 'transcript':
      return `${head}: "${outcome.text}" — transcribed from voice message (STT); ${tail}`;
    case 'unconfigured':
      return (
        `${head}: cannot transcribe — ${outcome.reason}. ` +
        `Tell the user you can't listen to voice messages until the operator configures transcription on this ours-mcp server, ` +
        `and ask them to send text meanwhile; ${tail}`
      );
    case 'failed':
      return (
        `${head}: transcription failed (${outcome.error}). ` +
        `Tell the user their voice message could not be transcribed right now and ask them to send text or retry; ${tail}`
      );
  }
}
