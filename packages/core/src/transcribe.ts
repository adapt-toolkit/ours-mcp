// packages/core/src/transcribe.ts
//
// Voice-message detection + (on GO) STT transcription for incoming files.
//
// Voice messages are a DISTINCT file type, not generic audio: the sending side
// (control-panel recorder) marks them explicitly, and the `mime` string set by
// the sender travels verbatim through ::a2a_messaging::send_file to the
// receiving wrapper — so detection is deterministic and needs no protocol
// change. Music/podcast/etc. audio without the marker is never treated as a
// voice message.

/**
 * The exact marker the panel puts in the file's mime string.
 * SINGLE SOURCE OF TRUTH — coordinate any change with the panel send side
 * (Designer-1); swapping the marker is a one-line change here.
 * Proposed: base type stays standard audio so saved files still play.
 */
export const VOICE_MESSAGE_MIME_MARKER = 'x-ours-kind=voice-message';

/** Secondary marker (fallback, also panel-controlled): filename prefix. */
export const VOICE_MESSAGE_FILENAME_PREFIX = 'voice-message-';

/** Deterministic voice-message check for an incoming file. */
export function isVoiceMessage(mime: string, filename: string): boolean {
  if (mime && mime.toLowerCase().includes(VOICE_MESSAGE_MIME_MARKER)) return true;
  return filename.toLowerCase().startsWith(VOICE_MESSAGE_FILENAME_PREFIX);
}
