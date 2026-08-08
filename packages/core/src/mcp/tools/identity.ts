// The nine GLOBAL-layer IDENTITY tools — create_identity,
// create_temporary_identity, close_temporary_identity, create_root_identity,
// define_local_identity_file, choose_identity, list_identities,
// current_identity, remove_identity.
//
// Converted from the handlers in `createMcpServer` (index.ts:3571-4090, baseline
// 22ffb646) onto `@ours.network/sdk`. Per src/mcp/tool.ts: take the zod
// arguments, call ONE SDK operation with the session context, render the typed
// result. The single-root policy, the temporary-identity ownership checks, the
// lease table and every catalogued error string now live in the SDK's
// src/api/identity.ts — none of them is re-derived here.
//
// WHY ctxFor IS CALLED PER HANDLER, NOT ONCE AT REGISTRATION
// `SessionContext`'s three members are getters, and `ctxFor()` is the per-session
// factory Developer-2's server owns. chooseIdentity and createIdentity REBIND the
// session as part of the call, so they must read the lease table as it is now.
// Nothing below captures ctx.leaseToken() or ctx.sessionId() into a local.
//
// The descriptions and zod schemas are the baseline's, character for character.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  OursError,
  chooseIdentity,
  closeTemporaryIdentityOp,
  createIdentity,
  createRootIdentity,
  createTemporaryIdentity,
  currentIdentity,
  defineLocalIdentityFile,
  listIdentities,
  removeIdentity,
} from '@ours.network/sdk';
import type { IdentityTreeRow, SessionContext } from '@ours.network/sdk';

import { runTool, textResult } from '../tool.js';

// The consent sentence create_identity, create_root_identity and choose_identity
// all append after binding. Baseline text (index.ts:3617, 3793, 3948) — one
// helper because the three copies were already identical, not a rewording.
const monitorHintFor = (name: string): string =>
  `\n\nAsk the user whether to enable this harness's live mail monitor for "${name}". ` +
  'Never enable monitoring without explicit consent.';

// The exposure clause of the two create tools. They differ ONLY in the
// not-exposed case: create_identity says so out loud (it exposes by default, so
// opting out is worth reporting), create_temporary_identity stays silent (it does
// NOT expose by default, so silence is the norm). index.ts:3614-3616 / 3684-3686.
const exposureClause = (exposed: boolean, autoAccept: boolean, whenNotExposed: string): string =>
  exposed
    ? ` Published to the local contact book${autoAccept ? '' : ' (introductions require approval)'}.`
    : whenNotExposed;

// The remove-me notice sentence, in its TWO baseline spellings. They are not
// interchangeable: close_temporary_identity's has a leading capital and a
// no-contacts variant (index.ts:3747-3751); remove_identity's is a trailing
// clause with a leading SPACE and collapses to '' when there were no contacts
// (index.ts:4063-4065). Both are also built inside the SDK for the deleteError
// path, where they are interpolated into the error message.
const closeNotice = (r: { attempted: number; notified: number; failed: number }): string =>
  r.attempted === 0
    ? 'It had no contacts, so no remove-me notices were needed.'
    : `Remove-me notices: ${r.notified}/${r.attempted} queued, ${r.failed} not sent ` +
      '(best effort — delivery and remote contact deletion are not guaranteed).';

const removeNotice = (r: { attempted: number; notified: number; failed: number }): string =>
  r.attempted === 0
    ? ''
    : ` Remove-me notices: ${r.notified}/${r.attempted} queued, ${r.failed} not sent (best effort).`;

// list_identities' two tag columns, from IdentityTreeRow's typed facts.
// `session: null` covers BOTH "no lease" and "lease held by a dead pid" — the SDK
// already collapsed them, because the baseline renders a dead holder as free.
const sessionTag = (row: IdentityTreeRow): string => {
  if (row.session === 'mine') return '  ← this session';
  if (row.session === 'other-live') return '  (in use by another session)';
  return '';
};

const tempTag = (row: IdentityTreeRow): string => {
  if (!row.temp) return '';
  switch (row.temp.state) {
    case 'closing':
      return ' [temporary — closing]';
    case 'mine':
      return ' [temporary — owned by THIS session]';
    case 'other-live':
      return ` [temporary — owned by another live session (pid ${row.temp.ownerPid})]`;
    case 'stale':
      return ' [temporary — STALE, owner gone, pending cleanup]';
  }
};

export function registerIdentityTools(server: McpServer, ctxFor: () => SessionContext): void {
  server.tool(
    'create_identity',
    'Create a new self-sovereign identity (an ADAPT node) with the given display ' +
      'name and bind it to this session. The name is what peers see for you in invites. ' +
      'Persisted permanently; reject if the name already exists. When a root identity ' +
      'exists on this host, the new identity is automatically delegated as a ROLE under ' +
      'it (its invites then carry the verified "role X of person Y" chain). By default the ' +
      'identity is published to the LOCAL contact book, so other identities on this ' +
      'host can message it by name without an invite; pass expose_local=false to opt out.',
    {
      name: z.string().min(1).describe('Display name for the new identity, e.g. "Alice".'),
      bio: z.string().default('').describe('Optional free-text bio for the identity profile.'),
      expose_local: z.boolean().default(true).describe('Publish this identity in the host-local contact book.'),
      local_auto_accept: z.boolean().default(true).describe('Auto-accept local contact-book introductions (false = they queue for approval).'),
    },
    async ({ name, bio, expose_local, local_auto_accept }) =>
      runTool(
        ctxFor(),
        (ctx) => createIdentity(ctx, { name, bio, exposeLocal: expose_local, localAutoAccept: local_auto_accept }),
        (r) => {
          // `underRoot` rather than r.info.rootName: the baseline names the root from
          // the in-memory Identity (index.ts:3596), which cannot degrade to '' when
          // the describe_identity read-back fails.
          const hierarchy =
            r.hierarchy === 'role'
              ? ` Delegated as a role under root "${r.underRoot}".`
              : ' No host root existed yet, so this identity is now the host ROOT (the person ' +
                'behind all roles); create more with create_identity and they become roles under it.' +
                (r.adopted.length
                  ? ` Adopted ${r.adopted.length} pre-existing identit${r.adopted.length === 1 ? 'y' : 'ies'} as role(s): ${r.adopted.join(', ')}.`
                  : '');
          const exposure = exposureClause(r.exposedLocal, r.localAutoAccept, ' Not exposed in the local contact book.');
          return textResult(
            `Created identity "${r.info.name}" (${r.info.cid}) and bound it to this session.${hierarchy}${exposure}${monitorHintFor(r.info.name)}`,
          );
        },
      ),
  );

  server.tool(
    'create_temporary_identity',
    'Create a TEMPORARY identity owned by this session and bind it. Temporary ' +
      'means session-scoped LOCAL lifetime: when this session ends (explicit ' +
      'close_temporary_identity, releasing the connection, or the client process ' +
      'dying), each contact is sent one best-effort "remove me from your contacts" ' +
      'notice and then ALL local state — keys, profile, contacts, messages, files — ' +
      'is deleted; the identity disappears from listings. The remove-me notice is ' +
      'fire-and-forget: remote contact deletion is NOT guaranteed (an offline or ' +
      'pre-0.13 peer keeps its entry). Ownership is exclusive: no other session can ' +
      'bind or delete it while this session lives. The identity is flat (never ' +
      'delegated under the host root) and, unlike create_identity, NOT published to ' +
      'the local contact book unless expose_local=true. Omit name for a ' +
      'collision-resistant random one.',
    {
      name: z.string().min(1).optional().describe('Optional public display name. Omitted: a random public-safe name like "tmp-1a2b3c4d5e" is generated.'),
      bio: z.string().default('').describe('Optional free-text bio for the identity profile.'),
      expose_local: z.boolean().default(false).describe('Publish in the host-local contact book (default false for a temporary identity).'),
      local_auto_accept: z.boolean().default(true).describe('Auto-accept local contact-book introductions (only relevant with expose_local).'),
    },
    async ({ name, bio, expose_local, local_auto_accept }) =>
      runTool(
        ctxFor(),
        (ctx) => createTemporaryIdentity(ctx, { name, bio, exposeLocal: expose_local, localAutoAccept: local_auto_accept }),
        (r) => {
          // r.info.name, not the `name` argument: when it was omitted the SDK minted
          // the random `tmp-…` one and that is what must be reported back.
          const exposure = exposureClause(r.exposedLocal, r.localAutoAccept, '');
          return textResult(
            `Created TEMPORARY identity "${r.info.name}" (${r.info.cid}) and bound it to this session ` +
              `(owner: this session's lease, client pid ${r.ownerPid}).${exposure}\n\n` +
              'Lifetime: session-scoped and local. Close it explicitly with close_temporary_identity ' +
              'when done; if the session ends or dies first, the daemon reclaims it automatically. ' +
              'On close, contacts get one best-effort remove-me notice (remote deletion NOT ' +
              'guaranteed) and all local state is deleted permanently.',
          );
        },
      ),
  );

  server.tool(
    'close_temporary_identity',
    'Close a temporary identity NOW: it stops accepting work, each contact is sent ' +
      'one best-effort fire-and-forget remove-me notice (delivery and remote ' +
      'removal are NOT guaranteed and not retried), then all of its local state — ' +
      'keys, profile, contacts, messages, files — is deleted permanently and it ' +
      'disappears from listings. Idempotent: closing an already-closing or ' +
      'already-gone identity is not an error. Only the owning session may close a ' +
      'temporary identity whose owner is still alive; a STALE one (owner process ' +
      'dead) may be closed by anyone to reclaim it. Defaults to the identity bound ' +
      'to this session.',
    { name: z.string().min(1).optional().describe('Temporary identity to close. Defaults to the one bound to this session.') },
    async ({ name }) =>
      runTool(
        ctxFor(),
        (ctx) => closeTemporaryIdentityOp(ctx, { name }),
        (r) =>
          // `result: null` is the idempotent no-op — a name that no longer exists.
          // The baseline answers it with a NON-error result (index.ts:3720), which is
          // why the SDK returns it instead of throwing.
          r.result === null
            ? textResult(`close_temporary_identity: no identity named "${r.name}" — nothing to close (already cleaned up?).`)
            : textResult(`Temporary identity "${r.name}" closed and all local state deleted. ${closeNotice(r.result)}`),
      ),
  );

  server.tool(
    'create_root_identity',
    'Create THE root identity for this host — the identity that represents the ' +
      'person behind all roles (see the identity hierarchy: one root, many roles). ' +
      'Single-root policy: exactly one root per host. If a root already exists, the ' +
      'named identity is instead created as a ROLE under it (no second root; no error). ' +
      'When establishing the root, every pre-existing identity is adopted as a role ' +
      '(each receives a delegation certificate). The root is directly messageable like ' +
      'any identity.',
    {
      name: z.string().min(1).describe('The person\'s name, e.g. "Vitalii Shakhmatov".'),
      bio: z.string().default('').describe('Free-text bio describing the person (carried in role invites).'),
      expose_local: z.boolean().default(true).describe('Publish the root in the host-local contact book.'),
      local_auto_accept: z.boolean().default(true).describe('Auto-accept local contact-book introductions (false = they queue for approval).'),
      skip_if_root_exists: z.boolean().default(false).describe('Installer seam: if a root already exists, do NOTHING (fail with "a root identity already exists") instead of adopting the name as a role. The ours-mcp create-root CLI sets this so re-runs stay idempotent; leave false for the interactive tool.'),
    },
    async ({ name, bio, expose_local, local_auto_accept, skip_if_root_exists }) =>
      runTool(
        ctxFor(),
        (ctx) =>
          createRootIdentity(ctx, {
            name,
            bio,
            exposeLocal: expose_local,
            localAutoAccept: local_auto_accept,
            skipIfRootExists: skip_if_root_exists,
          }),
        (r) => {
          const monitorHint = monitorHintFor(r.info.name);
          if (r.hierarchy === 'role') {
            // Single-root policy: a host root already existed, so this became a role
            // under it. Not an error — the response just says what happened.
            return textResult(
              `A host root already exists ("${r.underRoot}") — one root per host, so "${r.info.name}" ` +
                `(${r.info.cid}) was created as a ROLE under it instead and bound to this session.${monitorHint}`,
            );
          }
          const adoption =
            r.adopted.length > 0
              ? ` Adopted ${r.adopted.length} existing identit${r.adopted.length === 1 ? 'y' : 'ies'} as role(s): ${r.adopted.join(', ')}.`
              : '';
          const failures = r.failed.length > 0 ? ` FAILED to adopt: ${r.failed.join(', ')} (see daemon log).` : '';
          return textResult(
            `Created root identity "${r.info.name}" (${r.info.cid}) and bound it to this session.${adoption}${failures}${monitorHint}`,
          );
        },
      ),
  );

  server.tool(
    'define_local_identity_file',
    'Write a `.ours-identity` workspace-pin file that ties a directory to an ' +
      'identity. The pin is ADVISORY: a future Claude Code session here is told about ' +
      'it and asks the user before binding (or creating) the identity — nothing is ' +
      'auto-triggered by the file alone. Use this instead of hand-writing the file. ' +
      'Because this daemon is shared and its CWD is not the user\'s ' +
      'project, you MUST pass an absolute `path` (the target directory, or the full ' +
      'path ending in .ours-identity). Refuses to overwrite unless overwrite=true.',
    {
      name: z.string().min(1).describe('Identity name the workspace belongs to.'),
      path: z
        .string()
        .min(1)
        .describe('Absolute target: a directory (file is created inside it) or a full path ending in .ours-identity.'),
      force: z
        .boolean()
        .default(false)
        .describe('Once the user approves binding, eviction of another holder is pre-approved (no second confirmation).'),
      expose_local: z.boolean().default(true).describe('Publish this identity in the host-local contact book.'),
      local_auto_accept: z
        .boolean()
        .default(true)
        .describe('Auto-accept local contact-book introductions (false = they queue for approval).'),
      overwrite: z.boolean().default(false).describe('Replace an existing .ours-identity file.'),
    },
    async ({ name, path, force, expose_local, local_auto_accept, overwrite }) =>
      runTool(
        ctxFor(),
        // The one operation in this slice that is not session-scoped: it writes a
        // file, so the SDK takes no SessionContext.
        () =>
          defineLocalIdentityFile({
            name,
            path,
            force,
            exposeLocal: expose_local,
            localAutoAccept: local_auto_accept,
            overwrite,
          }),
        // `json` is the pin OBJECT; the pretty-printing is this layer's job.
        (r) => textResult(`Wrote ${r.written}:\n${JSON.stringify(r.json, null, 2)}`),
      ),
  );

  server.tool(
    'choose_identity',
    'Bind an existing identity to this session so the messaging tools act as it. ' +
      'Binding is exclusive: if the identity is already in use by another session, ' +
      'this is declined unless force=true, which evicts the other session. Never ' +
      'pass force=true on your own initiative — ask the user and get an explicit ' +
      'confirmation first.',
    {
      name: z.string().min(1).describe('Name of the identity to bind.'),
      force: z.boolean().default(false).describe('Evict another session that holds this identity.'),
    },
    async ({ name, force }) =>
      runTool(
        ctxFor(),
        (ctx) => chooseIdentity(ctx, { name, force }),
        (r) => {
          let msg = `Bound to identity "${r.name}" (${r.cid}).`;
          if (r.switchedFrom) {
            msg += `\n\nSwitched away from "${r.switchedFrom}" — disable any live monitor previously armed for it.`;
          }
          msg += monitorHintFor(r.name);
          return textResult(msg);
        },
      ),
  );

  server.tool(
    'list_identities',
    'List all identities hosted by this node (name + container id) as a hierarchy — ' +
      'the root identity first with its roles indented under it — marking which one ' +
      'is bound to this session and which are in use elsewhere. Temporary ' +
      '(session-scoped) identities are tagged with their lease state: owned by this ' +
      'session, owned by another live session, stale (owner gone, pending cleanup), ' +
      'or closing.',
    {},
    async () =>
      runTool(
        ctxFor(),
        (ctx) => listIdentities(ctx),
        (rows) => {
          if (rows.length === 0) {
            return textResult('No identities yet. Create a root with create_root_identity (or a flat identity with create_identity).');
          }
          // The rows arrive in RENDER ORDER (root, roles, flat). A no-root host is
          // detected exactly as the SDK documents it: no row claims 'root', because
          // the baseline never asks the packet for a role id in that case.
          const hasRoot = rows.some((row) => row.kind === 'root');
          const lines = rows.map((row) => {
            if (row.kind === 'root') return `★ ${row.name} — ${row.cid} (root)${sessionTag(row)}`;
            if (row.kind === 'role') return `  └ ${row.name} — ${row.cid} (role)${tempTag(row)}${sessionTag(row)}`;
            return hasRoot
              ? `• ${row.name} — ${row.cid} (flat, no delegation)${tempTag(row)}${sessionTag(row)}`
              : `• ${row.name} — ${row.cid}${tempTag(row)}${sessionTag(row)}`;
          });
          if (!hasRoot) lines.push('(no root identity yet — create_root_identity establishes the hierarchy)');
          return textResult(`Identities (${rows.length}):\n${lines.join('\n')}`);
        },
      ),
  );

  server.tool(
    'current_identity',
    'Report the identity currently bound to this session (if any), including its ' +
      'place in the identity hierarchy.',
    {},
    // ⚠ THE ONE HANDLER IN THIS SLICE THAT DOES NOT GO THROUGH runTool, and it is
    // deliberate. The baseline renders the not-bound case as a NON-error text
    // result — index.ts:4018 is `return textResult(b.error)` with no `true`, unlike
    // every other tool. Those four binding failures arrive from the SDK as
    // OursError, and runTool renders an OursError with isError: true, which would
    // flip this tool's flag and change its UX. So the message is rendered here with
    // the baseline's flag; the text itself is still the SDK's, unwrapped and
    // unmodified, and a non-OursError is still rethrown as a protocol error exactly
    // as runTool does. Developer-2: if you would rather this be a variant in
    // src/mcp/tool.ts (e.g. an isError override), say so and I will move it — I did
    // not widen your contract on my own.
    async () => {
      try {
        const r = await currentIdentity(ctxFor());
        // `described: false` means ::actor::describe_identity threw — the five
        // described fields are UNKNOWN, not empty — and the baseline degrades to the
        // bare line, dropping the hierarchy, temporary, bio and persona sentences.
        if (!r.described) return textResult(`Bound to "${r.name}" (${r.cid}).`);
        const place = r.isRoot
          ? ' — the ROOT identity of this host'
          : r.roleId !== ''
            ? ` — role "${r.roleId}" under root "${r.rootName}"`
            : '';
        const temp = r.temporary
          ? '\nTEMPORARY identity owned by this session — session-scoped local lifetime: closed ' +
            '(best-effort remove-me to each contact, then full local deletion) when this session ' +
            'ends or on close_temporary_identity.'
          : '';
        const bio = r.bio ? `\nBio: ${r.bio}` : '';
        const persona = r.persona ? `\nPersona: ${r.persona}` : '';
        return textResult(`Bound to "${r.name}" (${r.cid})${place}.${temp}${bio}${persona}`);
      } catch (err) {
        // NOT a missing `true` and NOT a forgotten runTool: index.ts:4018 renders
        // the not-bound case with isError FALSE, and this handler preserves that.
        if (err instanceof OursError) return textResult(err.message);
        throw err;
      }
    },
  );

  server.tool(
    'remove_identity',
    'Permanently delete a persisted identity — its packet and all on-disk state. ' +
      'This cannot be undone.',
    { name: z.string().min(1).describe('Name of the identity to delete.') },
    async ({ name }) =>
      runTool(
        ctxFor(),
        (ctx) => removeIdentity(ctx, { name }),
        (r) =>
          // A temporary identity goes out through its lifecycle path (ownership check
          // + best-effort remove-me notices), so it reports the notice counts; a
          // permanent one is a bare delete.
          r.kind === 'temporary' && r.close
            ? textResult(`Removed temporary identity "${r.name}" and its state.${removeNotice(r.close)}`)
            : textResult(`Removed identity "${r.name}" and its state.`),
      ),
  );
}
