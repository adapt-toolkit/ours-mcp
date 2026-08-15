// The three FILES tools, converted onto `@ours.network/sdk`.
//
//   list_incoming_files   get_files   save_file
//
// ============================================================================
// get_files IS THE ONE HANDLER IN THIS SLICE THAT DOES NOT USE runTool()
// ============================================================================
// Every other converted tool answers a failure with `textResult(err.message,
// true)`, which is exactly what runTool does. get_files does NOT: for the four
// SELECTION failures the baseline returns a `structuredContent` block carrying
// `error.category` and a per-wire_id `items` array, and the ours connector reads
// that block (index.ts:4924-4936). runTool cannot produce it — it renders text
// only — so this handler catches `OursError` itself and maps `code` →
// `error_category`. That mapping is the ONLY reason the SDK gives these four
// failures dedicated codes instead of a plain TX_FAILED (ours-sdk
// src/api/files.ts:7-18); losing it would forge four distinct categories into one
// with byte-identical text and no error.
//
// A non-selection failure still falls through to the plain `get_files failed: …`
// text result, and a non-`OursError` is still rethrown as the bug it is — the two
// properties runTool exists to guarantee are preserved here by hand, not dropped.
//
// ----- THE FINISHED SUMMARY TRAVELS; IT IS NOT REBUILT ----------------------
// `result.text` is the summary `writeIncomingFiles` already built, and it is
// passed STRAIGHT THROUGH as the tool's whole text content, exactly as baseline
// index.ts:4957 did. It is NOT redundant with `files`: two of the three voice
// branches interpolate raw strings that `structuredVoiceOutcome` discards
// (`unconfigured` drops `reason`; `failed` collapses `error` into a five-value
// category), so a consumer holding only the file records CANNOT rebuild it
// byte-identically. Re-typing the templates here would silently lose real
// message content on every failed transcription.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  FILE_SELECTION_CAP,
  OursError,
  errSaveFileFallback,
  getFiles,
  listIncomingFiles,
  saveFileFallbackNotice,
} from '@ours.network/sdk';
import type { SessionContext } from '@ours.network/sdk';

import { renderFiles } from '../format.js';
import { runTool, textResult, type McpTextResult } from '../tool.js';

// The four selection codes, and the `error_category` each one renders as. An
// explicit table rather than a lowercase() of the code: the categories are a wire
// contract the ours connector matches on, so they must not silently follow a
// rename of an SDK error code.
const SELECTION_CATEGORY: Record<string, string> = {
  INVALID_SELECTION: 'invalid_selection',
  MALFORMED_ID: 'malformed_id',
  DUPLICATE_ID: 'duplicate_id',
  UNKNOWN_OR_STALE_ID: 'unknown_or_stale_id',
};

// Every selection message from the SDK is already the finished tool text and
// begins with this prefix (ours-sdk src/errors.ts:220-231), because that text is
// what its api-error-parity gate holds byte-identical to the baseline. The
// baseline's `structuredContent.error.message` is the SAME sentence WITHOUT the
// prefix (index.ts:4925 adds it for the prose and 4933 omits it for the block),
// so the bare form is derived from the one source of truth rather than restated.
const GET_FILES_PREFIX = 'get_files failed: ';

export function registerFilesTools(server: McpServer, ctxFor: () => SessionContext): void {
  server.tool(
    'list_incoming_files',
    'List received files as structured metadata only — authenticated sender CID in ' +
      '`from.id`, untrusted display label in `from.name`, stable file_id/wire_id, filename, ' +
      'MIME, received size/date, status, and voice kind. Does not return/write bytes or ' +
      'change status. Authorize by from.id, then pass approved wire_ids to get_files. ' +
      'Requires a bound identity.',
    {},
    async () =>
      runTool(
        ctxFor(),
        (ctx) => listIncomingFiles(ctx),
        (files) => ({
          content: [{ type: 'text' as const, text: renderFiles(files) }],
          structuredContent: { count: files.length, files },
          isError: false,
        }),
      ),
  );

  server.tool(
    'get_files',
    'Retrieve selected unread files by stable wire_id, or (when wire_ids is omitted) all ' +
      'unread files for backward compatibility. Writes only retrieved files to disk under ' +
      "the identity's files dir (STATE_DIR/<identity>/files/<wire_id>-<name>) and returns " +
      'structured status, authenticated sender CID, IDs, path, filename/MIME, actual size, ' +
      'sha256, and voice transcription outcome — the BYTES are ' +
      'never returned into your context. Flips them to "processed" — the sole place file ' +
      'bytes leave the packet. If your OS user can read the returned path, use it directly; ' +
      'if you run as a different OS user than the daemon owner and cannot read it, the ours ' +
      'connector says so in the result and asks you for a destination — then call ' +
      'save_file({ wire_id, dest_path }) to stream a copy to a path you can write. ' +
      'Requires a bound identity.',
    {
      wire_ids: z.array(z.string()).optional().describe(
        `Optional 1-${FILE_SELECTION_CAP} unique 64-hex wire_ids from list_incoming_files. ` +
        'Omit for legacy bulk retrieval of every unread file.',
      ),
    },
    async ({ wire_ids }): Promise<McpTextResult> => {
      try {
        const out = await getFiles(ctxFor(), { wire_ids });
        // structuredContent carries the same records the prose lists. The proxy
        // reads it to probe readability as the agent's OS user (issue #34); no
        // outputSchema is declared, so this stays additive for every other client.
        return {
          content: [{ type: 'text' as const, text: out.text }],
          structuredContent: {
            files: out.files,
            selection: {
              mode: out.mode,
              // null — NOT [] — for the bulk form, which is how a caller tells
              // "every unread file" from "these zero files".
              requested_wire_ids: out.requested,
              items: out.files.map((file) => ({ wire_id: file.wire_id, status: file.status })),
            },
          },
          isError: false,
        };
      } catch (e) {
        // ⚠ DO NOT "TIDY" THIS BACK THROUGH runTool. Source: index.ts:4924-4936.
        // runTool renders `.message` and nothing else, so routing the four
        // SELECTION codes through it would render the same text and DROP this
        // whole block — no error, no log, on every bad selection. That is the same
        // silent-drop shape as the annotator frame trap. The connector reads
        // `error.category` and `selection.items[]`, so the block is behaviour, not
        // decoration. The two properties runTool guarantees are kept by hand here:
        // a non-OursError is rethrown as the bug it is, and any code outside the
        // four falls through to the plain text result.
        if (!(e instanceof OursError)) throw e; // a real bug — same rule as runTool
        const category = SELECTION_CATEGORY[e.code];
        if (!category) return textResult(e.message, true);
        const message = e.message.startsWith(GET_FILES_PREFIX)
          ? e.message.slice(GET_FILES_PREFIX.length)
          : e.message;
        return {
          content: [{ type: 'text' as const, text: e.message }],
          structuredContent: {
            files: [],
            selection: {
              // Always 'selected': all four categories require a selection —
              // bulk retrieval can never be over-long, malformed, duplicated or stale.
              mode: 'selected',
              // [] — NOT null — in the error block, unlike the success block above.
              requested_wire_ids: wire_ids ?? [],
              items: (wire_ids ?? []).map((wire_id) => ({ wire_id, status: 'error', error_category: category })),
            },
            error: { category, message },
          },
          isError: true,
        };
      }
    },
  );

  server.tool(
    'save_file',
    'Stream a received file (already pulled to disk by get_files) to a path YOUR OS user ' +
      'can write, WITHOUT the bytes ever entering your context. Use this when you run as a ' +
      'different OS user than the daemon owner and cannot read the get_files path directly. ' +
      'The ours connector streams the bytes daemon→proxy→disk (the proxy runs as your OS ' +
      'user and does the write); the file is resolved strictly within the bound identity\'s ' +
      'own files folder, so you can only save files delivered to YOU. Run get_files first so ' +
      'the file exists on disk. Requires a bound identity.',
    {
      wire_id: z.string().min(1).describe('wire_id of the received file (from get_files).'),
      dest_path: z.string().min(1).describe('Destination path on your local filesystem to write the copy to.'),
    },
    // Reaching THIS daemon-side handler means the ours proxy did not intercept and
    // fulfil the transfer — i.e. the connector is too old to stream+write the bytes as
    // your OS user. We deliberately do NOT write daemon-side: the daemon runs as its
    // owner, so a cross-user dest would be wrong-owner or EACCES. Fail clearly and point
    // at the fallback. A current proxy performs save_file locally and never forwards here.
    //
    // The sentence is built by the SDK's own `errSaveFileFallback` rather than
    // re-typed: its trailing parenthetical depends on `existsOnDisk`, and that
    // builder is what the error-parity gate holds to the baseline. The operation
    // only reports whether the file is on disk — nothing is saved either way.
    async ({ wire_id }) =>
      runTool(
        ctxFor(),
        (ctx) => saveFileFallbackNotice(ctx, { wire_id }),
        (notice) => textResult(errSaveFileFallback(wire_id, notice.existsOnDisk).message, true),
      ),
  );
}
