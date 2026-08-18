// The five MESSAGING tools, converted onto `@ours.network/sdk`.
//
//   send_message  send_file  list_incoming_messages  get_messages  defer_messages
//
// Each handler does the three things src/mcp/tool.ts allows and nothing else:
// take its zod arguments, call ONE SDK operation with the session context, render
// the typed result. There is no `withScopeAsync`, no `mutatingTx`, no
// `identities.get` and no hand-built error string in this file — if one appears,
// the conversion has regressed.
//
// ----- WHAT MOVED INTO THE SDK AND MUST NOT BE REPEATED HERE ----------------
// The baseline's `log('[e2e-route] …')` / `log('[migration] …')` verdict lines and
// the `send_not_retained` notify-log entry are DAEMON-SCOPED SIDE EFFECTS and
// travel with the engine — ours-sdk src/api/messaging.ts:100-121 and 198-214 run
// them. Re-emitting them here would double every route log and write the notify
// entry twice, which the connector's notification stream reads back.
//
// ----- WHAT DID NOT MOVE ----------------------------------------------------
// Every rendered sentence below. The SDK returns a verdict carrying `wireId`,
// `cid`, `queued` and `notRetained` and no prose, precisely so the wording stays
// here. The ONE exception is `kind: 'introduced'`, whose text is FINISHED prose
// from sendViaSibling / sendViaLocalBook describing an introduction that has
// already happened — the baseline passed that string straight to textResult
// (index.ts:4625) and so does this file. Re-deriving those two sentences here is
// exactly the drift the split exists to prevent.
import { readFileSync } from 'node:fs';
import { basename, resolve as resolvePath } from 'node:path';

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  errFileUnreadable,
  deferMessages,
  getMessages,
  listIncomingMessages,
  sendFile,
  sendMessage,
} from '@ours.network/sdk';
import type { OursClient } from '@ours.network/sdk';

import { fmtMsg } from '../format.js';
import { runTool, textResult } from '../tool.js';

export function registerMessagingTools(server: McpServer, clientFor: () => OursClient): void {
  server.tool(
    'send_message',
    'Send an end-to-end-encrypted message to a known contact (by name or container id). ' +
      'If the recipient is not a contact yet, the connection is established automatically ' +
      'when possible: an intra-root sibling (a role under the same root) connects via its ' +
      'delegation cert, and an identity published in the host-local contact book connects ' +
      'via a registrar introduction — either way the message is delivered with the ' +
      'introduction, no invite needed. To reply to a specific message, pass ' +
      'reply_to_wire_id (the wire_id from get_messages) and optionally ' +
      'reply_to_sentence (1-based index of the sentence you are answering). ' +
      'Requires a bound identity.',
    {
      contact: z.string().min(1).describe('Contact name or container id to send to.'),
      text: z.string().min(1).describe('The message text.'),
      reply_to_wire_id: z
        .string()
        .optional()
        .describe('wire_id (from get_messages) of the message this replies to.'),
      reply_to_sentence: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Optional 1-based sentence index in the replied-to message.'),
    },
    async ({ contact, text, reply_to_wire_id, reply_to_sentence }) =>
      runTool(
        clientFor(),
        (c) => c.sendMessage({ contact, text, reply_to_wire_id, reply_to_sentence }),
        (v) => {
          switch (v.kind) {
            case 'refused':
              return textResult(
                `Couldn't send to "${contact}" (wire_id ${v.wireId}): their end-to-end encryption must be ` +
                `re-established after an upgrade before messages can go through. It was NOT sent and NOT ` +
                `downgraded to the old channel — the system re-offers the upgrade automatically; try again shortly.`,
                true);
            case 'migrating':
              return textResult(
                `Message queued for "${contact}" (wire_id ${v.wireId}) — an encryption upgrade is completing; ` +
                `it will send automatically the moment the migration goes active ` +
                `(${v.queued} message${v.queued === 1 ? '' : 's'} queued).`);
            case 'e2e':
              if (v.notRetained) {
                return textResult(
                  `Message sent to "${contact}" over the end-to-end session (wire_id ${v.wireId}) — ` +
                  'WARNING: the message body exceeds the redrive budget, so it is NOT retained for automatic ' +
                  'resend. If the recipient loses its session, this message will NOT re-deliver automatically — ' +
                  'confirm receipt or resend once the contact is confirmed back.',
                );
              }
              return textResult(`Message sent to "${contact}" over the upgraded end-to-end session (wire_id ${v.wireId}).`);
            case 'deferred':
              return textResult(
                `Message queued for "${contact}" (wire_id ${v.wireId}) — the contact's encryption keys are being ` +
                `re-established after an upgrade (contact restore in progress); delivery is automatic once ` +
                `restored (${v.queued} message${v.queued === 1 ? '' : 's'} queued).`);
            // The contact-miss fallback. `text` is finished prose from the SDK —
            // the baseline's `return textResult(sent)` at index.ts:4625.
            case 'introduced':
              return textResult(v.text);
            default:
              return textResult(`Message sent to "${contact}" (wire_id ${v.wireId}).`);
          }
        },
      ),
  );

  server.tool(
    'send_file',
    'Send a file to a known contact (by name or container id). Provide EITHER `path` ' +
      '(the connector reads it as your OS user) OR `data_base64` + `filename` (inline bytes). ' +
      'Files and text are distinct messages — to caption a file, also send_message. ' +
      'Requires a bound identity.',
    {
      contact: z.string().min(1).describe('Contact name or container id to send to.'),
      path: z.string().min(1).optional().describe('Filesystem path to the file to send (preferred). Read by the ours connector as YOUR OS user, then streamed to the daemon.'),
      data_base64: z.string().min(1).optional().describe('Inline file bytes, base64-encoded (alternative to path).'),
      filename: z.string().min(1).optional().describe('Filename to advertise (required with data_base64; defaults to basename of path).'),
      mime: z.string().optional().describe('MIME type (inferred from the path extension when omitted).'),
      reply_to_wire_id: z.string().optional().describe('wire_id (from get_messages/get_files) this file replies to.'),
      reply_to_sentence: z.number().int().positive().optional().describe('Optional 1-based sentence index in the replied-to item.'),
    },
    // ⚠ `path` IS READ HERE, NOT BY THE DAEMON, AND THAT IS THE WHOLE POINT.
    //
    // `sendFile({path})` reads the file in the DAEMON's process as the DAEMON's OS
    // user. That is correct only while the caller and the daemon are one process.
    // This connector runs as the AGENT's user, so it reads the file itself and
    // streams the bytes to the staging route; the send then names the upload.
    //
    // Passing `path` straight through typechecks perfectly and fails only at
    // runtime, on someone else's machine, with a permissions error that has no
    // workaround. A green compile on this handler is not evidence of correctness.
    async ({ contact, path, data_base64, filename, mime, reply_to_wire_id, reply_to_sentence }) =>
      runTool(
        clientFor(),
        async (c) => {
          if (!path) {
            return c.sendFile({ contact, data_base64, filename, mime, reply_to_wire_id, reply_to_sentence });
          }
          const abs = resolvePath(path);
          let bytes: Buffer;
          try {
            bytes = readFileSync(abs);
          } catch (e) {
            // The SDK's own row for an unreadable file, raised on the side that
            // actually tried to read it.
            throw errFileUnreadable(String(e));
          }
          const staged = await c.uploadFile(new Uint8Array(bytes), {
            filename: filename ?? basename(abs),
            mime,
          });
          return c.sendFile({
            contact,
            upload_id: staged.upload_id,
            filename,
            mime,
            reply_to_wire_id,
            reply_to_sentence,
          });
        },
        (v) => {
          // The three facts the SDK carries for exactly this prefix (index.ts:4685):
          // `bytes` is the length of what was actually sent, so it is right for both
          // the `path` and the `data_base64` input forms.
          const desc = `File "${v.filename}" (${v.bytes} B${v.mime ? `, ${v.mime}` : ''})`;
          switch (v.kind) {
            case 'refused':
              return textResult(
                `Couldn't send ${desc} to "${contact}" (wire_id ${v.wireId}): their end-to-end encryption must be ` +
                `re-established after an upgrade first. It was NOT sent and NOT downgraded; the system re-offers ` +
                `the upgrade automatically — try again shortly.`,
                true);
            case 'migrating':
              return textResult(
                `${desc} not sent to "${contact}" yet — an encryption upgrade is completing; retry the file once ` +
                `the migration goes active (files aren't auto-queued like messages).`,
                true);
            case 'e2e':
              if (v.notRetained) {
                return textResult(
                  `${desc} sent to "${contact}" over the end-to-end session (wire_id ${v.wireId}) — ` +
                  'WARNING: the file exceeds the 2 MiB redrive budget, so it is NOT retained for automatic ' +
                  'resend. If the recipient loses its session (e.g. it was mid-restart), this file will NOT ' +
                  're-deliver automatically — confirm receipt or resend it once the contact is confirmed back.',
                );
              }
              return textResult(`${desc} sent to "${contact}" over the upgraded end-to-end session (wire_id ${v.wireId}).`);
            // UNREACHABLE for send_file, and present only because FileSendOutcome
            // is SendOutcome & {…} so it inherits the union member. sendFile has NO
            // contact-miss fallback — the baseline has no `/Unknown contact/` branch
            // here (ours-sdk src/api/files section, messaging.ts:145-149) — so a file
            // to a stranger is simply a failure. Rendering the SDK's own finished
            // prose is the only honest thing to do if that ever changes; inventing a
            // sentence here would not be.
            case 'introduced':
              return textResult(v.text);
            default:
              return textResult(`${desc} sent to "${contact}" (wire_id ${v.wireId}).`);
          }
        },
      ),
  );

  server.tool(
    'list_incoming_messages',
    "List ALL messages in the bound identity's inbox (decrypted), each with its id " +
      'and status (unread/read). A read-only history view — it does not change any ' +
      "status. To consume new mail use get_messages instead.",
    {},
    async () =>
      runTool(
        clientFor(),
        (c) => c.listIncomingMessages(),
        (inbox) => {
          if (inbox.length === 0) return textResult('Inbox is empty.');
          const unread = inbox.filter((m) => m.status === 'unread').length;
          return textResult(
            `Inbox (${inbox.length}, ${unread} unread):\n${inbox.map((m) => fmtMsg(m)).join('\n')}`,
          );
        },
      ),
  );

  server.tool(
    'get_messages',
    'Fetch the messages the bound identity has not seen yet (status "unread") and ' +
      'mark them "processed". This is the ONLY call that returns message bodies, and ' +
      'each message is delivered exactly once, so reading and acting on it immediately ' +
      'never double-processes — no acknowledgement call is needed. If you read a message ' +
      'but crash or want to hand it to another session before acting, call defer_messages ' +
      'to put it back to "unread"; otherwise handled messages are garbage-collected ' +
      'automatically. Returns ALWAYS-JSON: { count, messages: [{ msg_id, wire_id, ' +
      'from:{id,name}, encryption ("legacy" for a legacy box | "e2e" for the ' +
      'double-ratchet path), transport, text, date, status, reply_to }] } — so you can ' +
      'tell HOW each message arrived (ask the agent "how did you receive this"). Pass a ' +
      "message's wire_id as reply_to_wire_id in send_message to reply to it specifically.",
    {},
    async () =>
      runTool(
        clientFor(),
        (c) => c.getMessages(),
        // The payload crosses the boundary as an OBJECT and is stringified HERE —
        // index.ts:4848's line, kept in ours-mcp (ours-sdk api/types.ts:320-327).
        (payload) => textResult(JSON.stringify(payload, null, 2)),
      ),
  );

  server.tool(
    'defer_messages',
    'Put handled messages back into the queue (status "unread") so another ' +
      "session's get_messages picks them up. Works on messages you have read " +
      '(status "processed") and even ones already queued for GC ("ready_to_delete"), ' +
      'so a message stays recoverable across a full GC cycle.',
    { msg_ids: z.array(z.number().int()).min(1).describe('Message ids (from get_messages) to defer back to unread.') },
    async ({ msg_ids }) =>
      runTool(
        clientFor(),
        (c) => c.deferMessages({ msg_ids }),
        // `deferred` is the packet's own Visualize() string, interpolated unparsed
        // by the baseline (index.ts:4871) — not coerced to a number here either.
        (r) => textResult(`Deferred ${r.deferred} message(s) back to unread.`),
      ),
  );
}
