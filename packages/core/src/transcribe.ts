// packages/core/src/transcribe.ts
//
// Voice-message detection + (on GO) STT transcription for incoming files.
//
// Voice messages are a DISTINCT file type, not generic audio: the panel-side
// recorder marks them explicitly in the mime string, and the `mime` set by the
// sender travels verbatim through ::a2a_messaging::send_file to the receiving
// wrapper (handle_receive_file leaves it untouched) — so detection is
// deterministic and needs no protocol change. Music/podcast/etc. audio without
// the marker is never treated as a voice message.
//
// MARKER (locked with Designer-1, 2026-07-11): the panel emits
//   <base>; x-ours-kind=voice-message
// where <base> is the REAL recorded container and VARIES by browser:
// audio/mp4 (iOS Safari — MediaRecorder there only does mp4), audio/webm
// (Chrome/Android opus), audio/ogg (rare fallback). Match on the parameter,
// never on the base type. The real base mime must be passed through to the
// STT API on upload (whisper accepts m4a/mp4/webm/ogg).

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
  if (parts.slice(1).includes(VOICE_MESSAGE_MIME_PARAM)) return true;
  return (
    filename.toLowerCase().startsWith(VOICE_MESSAGE_FILENAME_PREFIX) &&
    parts[0].startsWith('audio/')
  );
}
