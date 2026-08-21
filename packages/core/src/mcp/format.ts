// MCP-shaped rendering. Everything in here is prose and MCP envelopes — no
// engine, no packets, no state. The SDK returns typed facts; this turns them
// into what a model reads.
//
// `annotateGetFilesResult` moved here from `proxy.ts:139` when the connector
// became `@ours.network/sdk/connector`. The SDK must not know what an MCP result
// looks like, so it calls a host hook instead — see THE FRAME CONTRACT below,
// which is the one thing about this move that can go wrong silently.
import { accessSync, constants as fsConstants } from 'node:fs';

import type { OursClient } from '@ours.network/sdk';

type IncomingFileMeta = Awaited<ReturnType<OursClient['listIncomingFiles']>>[number];
type InboxMsg = Awaited<ReturnType<OursClient['listIncomingMessages']>>[number];
type ReceivedFileMeta = Awaited<ReturnType<OursClient['getFiles']>>['files'][number];

// access(2) resolves against the REAL uid/gid and needs +x on every parent, so a
// daemon-owned 0700 state dir correctly reports unreadable here. No setuid in
// play, so real == effective and this is exactly what the agent would hit.
// proxy.ts:104-106, verbatim, and it lives HERE rather than at a call site so the
// override has ONE home. It forces the readability probe to report unreadable —
// for agents that must place received files explicitly (sandboxes, shared-uid
// containers) rather than reach into the daemon's state dir, and it is the seam
// test/file-save-stream.test.mjs uses to exercise the unreadable branch as a
// single OS user.
export const FILES_ALWAYS_PROMPT = ['1', 'true', 'yes', 'on'].includes(
  (process.env.OURS_FILES_ALWAYS_PROMPT ?? '').trim().toLowerCase(),
);

export const canRead = (p: string): boolean => {
  try { accessSync(p, fsConstants.R_OK); return true; } catch { return false; }
};

// ----- the two list renderers, moved here VERBATIM ---------------------------
//
// `renderFiles` is index.ts:3292 and `fmtMsg` is index.ts:3544, unchanged. They
// moved because the converted handlers live in src/mcp/tools/ and cannot import
// from index.ts, which is being emptied — and because rendering is what this file
// is for. The types are now the SDK's `IncomingFileMeta` / `InboxMsg`, which are
// the same shapes index.ts declared locally.
//
// ⚠ index.ts STILL HAS ITS OWN COPY of both, because the `ours://inbox` RESOURCE
// (index.ts:4095-4107) uses fmtMsg and is not a tool, so it belongs to no
// registrar. Those copies are duplicates from now on: whoever moves that resource
// must delete them and import from here, or the two will drift.

function renderFiles(files: IncomingFileMeta[]): string {
  if (files.length === 0) return 'No files received.';
  const lines: string[] = [];
  for (const file of files) {
    const voiceTag = file.kind === 'voice_message' ? '🎤 voice message · ' : '';
    lines.push(
      `  • ${voiceTag}${file.filename} (${file.mime}, ${file.size} B) from ${file.from.name} ` +
      `[${file.status}] {${file.wire_id}} sender_id=${file.from.id}`,
    );
  }
  return `${lines.length} file(s):\n${lines.join('\n')}`;
}

// One-line message rendering: id + sender + body + date, with status when not
// the default "unread" (so list views show what's already been read).
function fmtMsg(m: InboxMsg, withStatus = true): string {
  const status = withStatus && m.status && m.status !== 'unread' ? ` [${m.status}]` : '';
  const wire = m.wire_id ? ` {${m.wire_id}}` : '';
  const reply = m.reply_to
    ? ` ↳re ${m.reply_to.wire_id}${m.reply_to.sentence ? `·s${m.reply_to.sentence}` : ''}`
    : '';
  return `#${m.msg_id} [${m.sender_name}]${status}${wire}${reply} ${m.text}  (${m.date})`;
}

export { fmtMsg, renderFiles };

const describeFile = (f: ReceivedFileMeta): string =>
  `  • ${f.filename} — ${f.mime || 'application/octet-stream'}, ${f.size} B, ` +
  `sha256 ${f.sha256} — from ${f.sender} — wire_id ${f.wire_id}`;

/**
 * Annotate a get_files RESULT in place when some of its files are not readable
 * by this OS user. Returns true if the result was annotated. No
 * structuredContent (an older daemon) means no probe and no annotation — pure
 * passthrough.
 *
 * The instruction is PREPENDED, never substituted for the daemon's own text.
 * That text can carry payload the proxy cannot reconstruct — a voice message is
 * delivered as a TRANSCRIPT, not as a path — so replacing it wholesale would
 * drop real message content whenever an unreadable file shares a batch with one.
 *
 * Unchanged from `proxy.ts:139`. What changed is who calls it — see below.
 */
export function annotateGetFilesResult(result: unknown, readable: (p: string) => boolean): boolean {
  const r = result as
    | { content?: Array<{ type: string; text?: string }>; structuredContent?: { files?: unknown }; isError?: boolean }
    | undefined;
  if (!r || r.isError) return false;
  const raw = r.structuredContent?.files;
  if (!Array.isArray(raw)) return false;
  const files = raw.filter(
    (f): f is ReceivedFileMeta =>
      !!f && typeof f === 'object' && typeof (f as ReceivedFileMeta).path === 'string' && typeof (f as ReceivedFileMeta).wire_id === 'string',
  );
  if (files.length === 0) return false;

  // Voice delivery remains transcript-first for compatibility. Its structured
  // record still exposes the audio path/readability, but an unreadable daemon
  // copy must not turn a successfully delivered transcript/fallback into an
  // unsolicited destination prompt.
  const blocked = files.filter((f) => f.kind !== 'voice_message' && !readable(f.path));
  // Annotate the structured records either way so a structured consumer sees the
  // same truth the prose does.
  for (const f of files) (f as ReceivedFileMeta & { readable: boolean }).readable = readable(f.path);
  if (blocked.length === 0) return false;

  const lines: string[] = [
    `${blocked.length} of ${files.length} received file(s) are NOT readable by your OS user: the ours ` +
      `daemon runs as a different OS user and keeps its files dir private. Nothing was lost — the bytes ` +
      `are safely on disk. IGNORE the on-disk paths reported below for these files; you cannot open them.`,
    '',
    `TELL THE USER what arrived (details below) and ASK WHERE TO SAVE each file on this filesystem. ` +
      `Then call save_file({ wire_id, dest_path }) with the path they choose: the ours connector streams ` +
      `the bytes daemon→proxy→disk and writes them as YOUR OS user. The bytes never enter this conversation.`,
    '',
    'Awaiting a destination:',
    ...blocked.map(describeFile),
  ];
  r.content = [{ type: 'text', text: lines.join('\n') }, ...(r.content ?? [])];
  return true;
}

// `annotateResultFrame` USED TO BE HERE AND IS GONE WITH THE PROXY.
//
// It unwrapped a JSON-RPC frame's `.result` and handed it to the annotator above,
// because the proxy only ever saw FRAMES. The tool handler sees the RESULT
// OBJECT directly (src/mcp/tools/files.ts), so the wrapper has no caller and no
// reason to exist. Its trap is worth remembering rather than the function:
// passing the annotator a frame instead of a result annotates NOTHING, silently.
