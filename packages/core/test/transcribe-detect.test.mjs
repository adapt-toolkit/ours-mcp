// Voice-message detection: deterministic, marker-driven, never generic audio.
import { isVoiceMessage, VOICE_MESSAGE_MIME_MARKER } from '../dist/transcribe.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓', m)) : (fail++, console.log('  ✗ FAIL:', m)); };

ok(isVoiceMessage(`audio/ogg; ${VOICE_MESSAGE_MIME_MARKER}`, 'a.ogg'), 'mime marker detected');
ok(isVoiceMessage(`AUDIO/OGG; X-OURS-KIND=VOICE-MESSAGE`, 'a.ogg'), 'mime marker is case-insensitive');
ok(isVoiceMessage('application/octet-stream', 'voice-message-2026.ogg'), 'filename prefix fallback detected');
ok(!isVoiceMessage('audio/mpeg', 'song.mp3'), 'plain mp3 music is NOT a voice message');
ok(!isVoiceMessage('audio/ogg', 'recording.ogg'), 'unmarked ogg audio is NOT a voice message');
ok(!isVoiceMessage('', 'file.bin'), 'empty mime, unmarked name → not voice');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
