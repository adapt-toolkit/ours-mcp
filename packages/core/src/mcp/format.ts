// MCP-shaped rendering. Everything in here is prose and MCP envelopes — no
// engine, no packets, no state. The SDK returns typed facts; this turns them
// into what a model reads.
//
// `annotateGetFilesResult` moved here from `proxy.ts:139` when the connector
// became `@ours.network/sdk/connector`. The SDK must not know what an MCP result
// looks like, so it calls a host hook instead — see THE FRAME CONTRACT below,
// which is the one thing about this move that can go wrong silently.
import { accessSync, constants as fsConstants } from 'node:fs';

import type { ReceivedFileMeta } from '@ours.network/sdk';

// access(2) resolves against the REAL uid/gid and needs +x on every parent, so a
// daemon-owned 0700 state dir correctly reports unreadable here. No setuid in
// play, so real == effective and this is exactly what the agent would hit.
export const canRead = (p: string): boolean => {
  try { accessSync(p, fsConstants.R_OK); return true; } catch { return false; }
};

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

/**
 * ============================================================================
 * THE FRAME CONTRACT — the reason this adapter exists at all
 * ============================================================================
 * `proxy.ts` used to unwrap the JSON-RPC envelope itself before annotating:
 *
 *     annotateGetFilesResult((msg as { result?: unknown }).result, …)   // proxy.ts:704
 *
 * The SDK connector deliberately does NOT, because it must not know what an MCP
 * result looks like. It hands the host the WHOLE RESPONSE FRAME:
 *
 *     opts.annotateResult?.(msg)          // sdk src/connector.ts:731
 *
 * Passing `annotateGetFilesResult` straight in as the hook therefore hands it
 * `{jsonrpc, id, result}`, where `structuredContent` is `undefined` — so it
 * returns false and DOES NOTHING, on every cross-user get_files, with no error
 * and no log line on either side of the seam. This adapter is the fix, and it is
 * the only correct way to install the annotator.
 *
 * Gated by `test/annotate-frame.test.mjs` here and by
 * `test/proxy-annotate-hook.test.mjs` in ours-sdk — the two halves of one
 * contract, one test each side.
 */
export function annotateResultFrame(message: unknown, readable: (p: string) => boolean = canRead): boolean {
  const frame = message as { result?: unknown } | undefined;
  if (!frame || typeof frame !== 'object' || !('result' in frame)) return false;
  return annotateGetFilesResult(frame.result, readable);
}
