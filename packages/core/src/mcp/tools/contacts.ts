// The ten CONTACTS tools — generate_invite, list_invites, revoke_invite,
// add_contact, list_contacts, list_local_contact_book, set_local_book_policy,
// respond_to_introduction, remove_contact, rename_contact.
//
// Converted from the handlers in `createMcpServer` (index.ts:4110-4371,
// 4463-4499 and 4722-4795, baseline 22ffb646) onto `@ours.network/sdk`. Per
// src/mcp/tool.ts: take the zod arguments, call ONE SDK operation with the
// session context, render the typed result.
//
// THREE THINGS THAT USED TO LIVE HERE AND NOW DO NOT — do not put them back:
//   * removeContact's `outboundRemovalInFlight` add/delete bracket. It is the
//     only way the core's on_contact_removed handler can tell "we removed them"
//     from "they removed us", and it is now inside the SDK's removeContact, held
//     across the whole transaction. A second copy of that Set makes the reader's
//     `.has()` permanently false.
//   * listContacts' FIVE read-only transactions in ONE scope. One scope is one
//     consistent snapshot; the SDK holds it and hands back the five views.
//   * addContact building its binary from the bound identity's OWN packet.
// All three are the SDK's now, and none of them is observable from this file —
// which is the point of the split.
//
// The descriptions and zod schemas are the baseline's, character for character.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OursClient } from '@ours.network/sdk';

import { buildContactLines } from '../../contacts.js';
import { runTool, textResult } from '../tool.js';

type ContactRoot = Awaited<ReturnType<OursClient['listContacts']>>['roots'][string];

// One-line verified-linkage tag for a contact: who is behind it, as what.
//
// Moved verbatim from index.ts:3452 — list_contacts (index.ts:4298) was its only
// caller, so it belongs with the handler rather than in the daemon.
// Developer-2: this is the copy; delete index.ts's when its handlers go.
function fmtContactRoot(r: ContactRoot | undefined): string {
  if (!r) return '';
  const who = r.root_name || r.root_cid;
  return r.role_id ? `  [role "${r.role_id}" of ${who}]` : `  [root identity of ${who}]`;
}

export function registerContactsTools(server: McpServer, clientFor: () => OursClient): void {
  server.tool(
    'generate_invite',
    'Generate an invite to share out-of-band with another agent. The invite ' +
      'carries your identity and display name. If you pass a name, whoever redeems ' +
      'the invite is registered under it; without a name, the redeemer is registered ' +
      'under the name they announce when accepting. mode selects the invite kind: ' +
      '"one_time" (the default when omitted — consumed by the first redemption) or ' +
      '"public" (reusable, meant for open posting; every redeemer gets an independent ' +
      'channel; close it with revoke_invite — it has no expiry and is never consumed). ' +
      'A public invite cannot pre-assign a contact name, and does not survive a daemon ' +
      'restart (it must be re-generated and re-posted). Requires a bound identity.',
    {
      name: z.string().min(1).optional().describe('Optional name to register the peer who redeems this invite, e.g. "Bob". Omit to register them under their own name on acceptance. Not allowed with mode "public".'),
      mode: z.enum(['one_time', 'public']).optional().describe('Invite kind. Omitted means "one_time" (single redemption, unchanged legacy behavior). "public" mints a reusable invite for open posting.'),
    },
    async ({ name, mode }) =>
      runTool(
        clientFor(),
        (c) => c.generateInvite({ name, mode }),
        (r) => {
          // The heading needs the caller's own `name` argument as well as the result:
          // a one-time invite reads differently depending on whether a name was
          // pre-assigned, and that is an input, not something the packet reports.
          const heading =
            r.mode === 'public'
              ? `Reusable public invite created (invite_id ${r.inviteId}). Anyone holding the blob can redeem it, each as an independent contact, until you revoke_invite it. It will NOT survive a daemon restart — re-generate and re-post after one.`
              : name
                ? `One-time invite for "${name}" created (invite_id ${r.inviteId}).`
                : `One-time invite created (invite_id ${r.inviteId}) — the contact will be registered under the name the recipient announces when accepting.`;
          return textResult(
            `${heading} Share this blob out-of-band (they paste it into add_contact):\n\n${r.blob}`,
          );
        },
      ),
  );

  server.tool(
    'list_invites',
    'List the outstanding invites the bound identity has minted and not yet seen ' +
      'redeemed or revoked: invite_id, kind (one_time | public), assigned peer name ' +
      'if any, and creation time. Carries no key material. Use revoke_invite to ' +
      'close one — essential for public invites, which are never consumed.',
    {},
    async () =>
      runTool(
        clientFor(),
        (c) => c.listInvites(),
        (rows) => {
          if (rows.length === 0) return textResult('No outstanding invites.');
          // `assigned` / `created` are '' (never the packet's '%%NIL' sentinel) when
          // absent — the SDK normalises it, so an empty string is the whole test.
          const lines = rows.map((r) =>
            `• ${r.invite_id} — ${r.mode}${r.assigned ? `, assigned name "${r.assigned}"` : ''}${r.created ? `, created ${r.created}` : ''}`,
          );
          return textResult(`Outstanding invites (${rows.length}):\n${lines.join('\n')}`);
        },
      ),
  );

  server.tool(
    'revoke_invite',
    'Revoke an outstanding invite by invite_id (from generate_invite or ' +
      'list_invites). The only way to close a public invite, which has no expiry ' +
      'and is never consumed by redemption. Idempotent: revoking an unknown or ' +
      'already-consumed id reports revoked=false rather than failing. Note: ' +
      'revoking does NOT remove contacts already admitted through the invite — ' +
      'to keep a specific peer out, revoke_invite first, then remove_contact.',
    { invite_id: z.string().min(1).describe('The invite_id to revoke.') },
    async ({ invite_id }) =>
      runTool(
        clientFor(),
        (c) => c.revokeInvite({ invite_id }),
        (r) => {
          // revoked: false is the idempotent no-op, and it is NOT an error result.
          if (!r.revoked) {
            return textResult(`Invite ${invite_id} was not found (already consumed, revoked, or never existed) — nothing to revoke.`);
          }
          const kind = r.wasPublic ? 'public' : 'one_time';
          return textResult(`Invite ${invite_id} (${kind}) revoked. Existing contacts admitted through it are unaffected.`);
        },
      ),
  );

  server.tool(
    'add_contact',
    "Add a contact from an invite blob produced by another agent's generate_invite. " +
      "If no name is given, the inviter's embedded display name is used. Also replies " +
      'to the inviter so they register you back. Requires a bound identity.',
    {
      invite: z.string().min(1).describe('The base64 invite blob to redeem.'),
      name: z.string().min(1).optional().describe("Optional custom name for the inviter; defaults to their own name."),
    },
    async ({ invite, name }) =>
      runTool(
        clientFor(),
        (c) => c.addContact({ invite, name }),
        // `display` is the packet's own choice of label — pending name, else the
        // inviter's announced name, else the container id.
        (r) => textResult(`Added contact "${r.display}" (${r.cid}).`),
      ),
  );

  server.tool(
    'list_contacts',
    'List the contacts the bound identity knows about (name + container id), plus ' +
      'any pending local-contact-book introductions awaiting approval.',
    {},
    async () =>
      runTool(
        clientFor(),
        (c) => c.listContacts(),
        ({ contacts, pending, roots, degraded, renames }) => {
          const degradedByCid = new Map(degraded.map((d) => [d.cid, d]));
          const lines: string[] = [];
          lines.push(
            contacts.length === 0
              ? 'No contacts yet.'
              : `Contacts (${contacts.length}):\n${buildContactLines(
                  contacts.map((c) => ({
                    name: c.name,
                    container_id: c.container_id,
                    rootTag: fmtContactRoot(roots[c.container_id]),
                    degradedQueued: degradedByCid.get(c.container_id)?.queued,
                    renamedFrom: renames[c.container_id],
                  })),
                ).join('\n')}`,
          );
          if (pending.length > 0) {
            lines.push(
              `Pending local introductions (${pending.length}) — approve/reject with respond_to_introduction:\n` +
                pending.map((p) => `• ${p.name} — ${p.container_id} (${p.queued} queued message${p.queued === 1 ? '' : 's'})`).join('\n'),
            );
          }
          return textResult(lines.join('\n\n'));
        },
      ),
  );

  server.tool(
    'list_local_contact_book',
    'List the host-local contact book: identities on THIS host that are exposed for ' +
      'inviteless connection. Any of them can be messaged directly with send_message.',
    {},
    // HOST-WIDE and deliberately NOT bound-identity-scoped: the SDK operation calls
    // no requireBound, so an unbound session can still read the book — which is the
    // one moment an agent most needs it. `isMine` is still session-scoped.
    async () =>
      runTool(
        clientFor(),
        (c) => c.listLocalContactBook(),
        (entries) => {
          if (entries.length === 0) return textResult('The local contact book is empty.');
          const lines = entries.map((e) => {
            const tag = e.isMine ? '  ← this session' : '';
            return `• ${e.name} — ${e.container_id} (published ${e.published_at})${tag}`;
          });
          return textResult(`Local contact book (${entries.length}):\n${lines.join('\n')}`);
        },
      ),
  );

  server.tool(
    'set_local_book_policy',
    "Change the bound identity's local-contact-book settings: expose (publish/" +
      'unpublish it in the book) and/or auto_accept (whether local introductions are ' +
      'accepted automatically or queue for approval).',
    {
      expose: z.boolean().optional().describe('Publish (true) or remove (false) this identity in the local contact book.'),
      auto_accept: z.boolean().optional().describe('Auto-accept local introductions (false = queue them for approval).'),
    },
    async ({ expose, auto_accept }) =>
      runTool(
        clientFor(),
        (c) => c.setLocalBookPolicy({ expose, auto_accept }),
        // `changes` arrives already worded and already ORDERED (policy before
        // exposure) because that wording and that order are baseline UX; this layer
        // adds only the frame.
        (r) => textResult(`Updated "${r.identity}": ${r.changes.join('; ')}.`),
      ),
  );

  server.tool(
    'respond_to_introduction',
    'Approve or reject a pending local-contact-book introduction (see list_contacts ' +
      'for the pending list). Approving registers the contact and delivers any messages ' +
      'it queued while waiting; rejecting drops the introduction and its queue.',
    {
      contact: z.string().min(1).describe('Pending introduction to act on (name or container id).'),
      action: z.enum(['approve', 'reject']).describe('approve or reject.'),
    },
    async ({ contact, action }) =>
      runTool(
        clientFor(),
        (c) => c.respondToIntroduction({ contact, action }),
        // Discriminated on `action` because the two paths report different facts —
        // and have different side effects, which the SDK owns: approving flushes the
        // queued messages and schedules a capability reconcile, rejecting does neither.
        (r) =>
          r.action === 'approve'
            ? textResult(
                `Approved "${r.name}" (${r.cid}) — now a contact. ${r.flushed} queued message(s) moved to the inbox (read them with get_messages).`,
              )
            : textResult(`Rejected the introduction from "${r.name}" and dropped ${r.dropped} queued message(s).`),
      ),
  );

  server.tool(
    'remove_contact',
    'Forget a contact (by name or container id) — drops it from the bound identity\'s ' +
      'contacts, so you can no longer message them and inbound messages from them are ' +
      'rejected. Also sends the peer one best-effort authenticated "remove me from ' +
      'your contacts" notice so a supporting peer drops you too — fire-and-forget: ' +
      'queued once, never retried or acknowledged, so remote removal is NOT ' +
      'guaranteed (an offline peer or a dropped packet leaves the removal local-only, ' +
      'and a pre-0.13 or degraded peer is sent nothing at all). This is a ' +
      'contacts-layer forget, NOT a key wipe: the per-peer channel ' +
      'key material persists, so re-adding the same peer reuses the existing encrypted ' +
      'channel rather than re-handshaking. Removal is NOT retirement: a later ' +
      'send_message to the removed peer auto-reconnects — for ANY live identity on this ' +
      'host under the same root, via the sibling path (this fires first and does not ' +
      'need a contact-book entry, published or not); otherwise through the host-local ' +
      'contact book if the peer is still published there. To stop reaching a peer for ' +
      'good, address sends by container id and do not send to it. Requires a bound identity.',
    { contact: z.string().min(1).describe('Contact name or container id to remove.') },
    async ({ contact }) =>
      runTool(
        clientFor(),
        (c) => c.removeContact({ contact }),
        (r) => {
          // `notified` is TRI-STATE and the third state is load-bearing: undefined
          // means the packet said nothing (a pre-0.13 or degraded peer — nothing was
          // even attempted), which renders as NO sentence at all. Collapsing it into
          // false would promise "no notice was sent" for a peer never asked.
          // $notified TRUE means the notice was QUEUED to the transport, never
          // that the peer applied it (fire-and-forget, not redrivable).
          const remote = r.notified === undefined
            ? ''
            : r.notified
              ? ' A best-effort removal notice was sent to the peer (delivery and remote removal are not guaranteed).'
              : ' No removal notice was sent (the peer does not support it or is unreachable) — the removal is local-only.';
          return textResult(`Removed contact "${r.name}" (${r.cid}).${remote}`);
        },
      ),
  );

  server.tool(
    'rename_contact',
    'Rename a contact (addressed by current name or container id) — rewrites the ' +
      'display name only; the container id, keys and the established encrypted ' +
      'channel are untouched. Rejects a name another contact already holds. When ' +
      'two contacts share a name (e.g. after a collision took an ordinal suffix), ' +
      'address the one to rename by its container id. Requires a bound identity.',
    {
      contact: z.string().min(1).describe('Contact name or container id to rename.'),
      name: z.string().min(1).describe('The new display name.'),
    },
    async ({ contact, name }) =>
      runTool(
        clientFor(),
        (c) => c.renameContact({ contact, name }),
        // `from` is the PREVIOUS display name; the new one is the caller's argument.
        (r) => textResult(`Renamed contact "${r.from}" to "${name}" (${r.cid}).`),
      ),
  );
}
