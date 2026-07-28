// Voice-message detection: deterministic, marker-driven, never generic audio.
// Marker locked with Designer-1: <varying real base>; x-ours-kind=voice-message.
import { isVoiceMessage, VOICE_MESSAGE_MIME_PARAM } from '../dist/transcribe.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓', m)) : (fail++, console.log('  ✗ FAIL:', m)); };

// primary: param match, base type VARIES (iOS mp4 / Chrome webm / ogg fallback)
ok(isVoiceMessage(`audio/mp4; ${VOICE_MESSAGE_MIME_PARAM}`, 'voice-message-20260711-193210.m4a'), 'iOS Safari mp4 base detected');
ok(isVoiceMessage(`audio/webm; ${VOICE_MESSAGE_MIME_PARAM}`, 'voice-message-20260711-193210.webm'), 'Chrome/Android webm base detected');
ok(isVoiceMessage(`audio/ogg; ${VOICE_MESSAGE_MIME_PARAM}`, 'a.ogg'), 'ogg fallback base detected');
ok(isVoiceMessage(`audio/ogg; ${VOICE_MESSAGE_MIME_PARAM}`, 'voice_705.ogg'), 'Telegram OGG/Opus fallback is accepted by the exact MIME contract');
ok(isVoiceMessage('AUDIO/MP4; X-OURS-KIND=VOICE-MESSAGE', 'a.m4a'), 'param match is case-insensitive');
ok(isVoiceMessage('audio/webm;x-ours-kind=voice-message', 'a.webm'), 'no space after semicolon still matches');
ok(isVoiceMessage(`audio/mp4; codecs=mp4a.40.2; ${VOICE_MESSAGE_MIME_PARAM}`, 'a.m4a'), 'param found among multiple parameters');

// fallback: filename prefix requires an audio/* base
ok(isVoiceMessage('audio/mp4', 'voice-message-20260711-193210.m4a'), 'filename fallback with audio/* base detected');
ok(!isVoiceMessage('application/octet-stream', 'voice-message-20260711.ogg'), 'filename fallback WITHOUT audio/* base rejected');

// never generic audio / near-misses
ok(!isVoiceMessage('audio/mpeg', 'song.mp3'), 'plain mp3 music is NOT a voice message');
ok(!isVoiceMessage('audio/ogg', 'voice_705.ogg'), 'connector-specific voice_<id>.ogg without the marker stays rejected');
ok(!isVoiceMessage('application/octet-stream; x-ours-kind=voice-message', 'voice_705.ogg'), 'marked non-audio payload stays rejected');
ok(!isVoiceMessage('audio/ogg', 'recording.ogg'), 'unmarked ogg audio is NOT a voice message');
ok(!isVoiceMessage('audio/mp4; x-ours-kind=voice-messages', 'a.m4a'), 'near-miss param value rejected');
ok(!isVoiceMessage('x-ours-kind=voice-message', 'a.bin'), 'marker as BASE type (not a parameter) rejected');
ok(!isVoiceMessage('', 'file.bin'), 'empty mime, unmarked name → not voice');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
