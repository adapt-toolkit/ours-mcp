// The three PROFILE tools — set_bio, advertise_migrate, set_persona.
//
// Converted from the handlers in `createMcpServer` (index.ts:4373-4462, baseline
// 22ffb646) onto `@ours.network/sdk`. Each handler now does exactly what
// src/mcp/tool.ts says a handler does: take its zod arguments, call ONE SDK
// operation with the session context, render the typed result. The packet
// transactions, the root-profile re-pin loop and the error text all live in the
// SDK's src/api/profile.ts now.
//
// THE ASYMMETRY BETWEEN set_bio AND set_persona IS PRESERVED, and it is not
// visible from here: set_bio re-signs every role's delegation chain (a role's
// invites carry a COPY of the root's profile) and reports how many roles it
// refreshed; set_persona does not, because the persona is a LOCAL operating
// contract that never enters an invite. That is why only SetBioResult has a
// `rolesRefreshed` count to render.
//
// The descriptions and zod schemas below are the baseline's, character for
// character. They are the product, and the ux-strings gate freezes them.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { advertiseMigrate, setBio, setPersona } from '@ours.network/sdk';
import type { SessionContext } from '@ours.network/sdk';

import { runTool, textResult } from '../tool.js';

export function registerProfileTools(server: McpServer, ctxFor: () => SessionContext): void {
  server.tool(
    'set_bio',
    "Set the bound identity's profile bio (free text). For a role, the bio is " +
      'embedded in the invites it generates. For the root identity, the refreshed ' +
      'profile is re-pinned into every role so future role invites carry the update.',
    { bio: z.string().describe('The new bio text (empty string clears it).') },
    async ({ bio }) =>
      runTool(
        ctxFor(),
        (ctx) => setBio(ctx, { bio }),
        (r) => {
          const suffix = r.rolesRefreshed > 0 ? ` Root profile refreshed in ${r.rolesRefreshed} role(s).` : '';
          return textResult(`Updated the bio of "${r.identity}".${suffix}`);
        },
      ),
  );

  server.tool(
    'advertise_migrate',
    'Enable the e2e-migration capability (core.e2e.migrate) at runtime on the bound ' +
      'identity and proactively offer migration to every already-known eligible e2e ' +
      'contact. This is the staged-advertise trigger: an identity booted WITHOUT the ' +
      'migrate cap (so it forms a plain e2e session first) calls this to start the SAME ' +
      'migrations a default-cap boot would — closing the already-e2e-pair gap where a ' +
      'pinned pair with no inbound traffic would otherwise never migrate. Idempotent: ' +
      're-enabling is a no-op for the cap, and the offer election stays fail-closed. ' +
      'Returns how many migration offers were initiated.',
    {},
    async () =>
      runTool(
        ctxFor(),
        (ctx) => advertiseMigrate(ctx),
        ({ wasAdvertising, advertising, offers }) => {
          const already = wasAdvertising ? ' (already advertising — cap unchanged)' : '';
          return textResult(
            `advertise_migrate: core.e2e.migrate ${advertising ? 'advertised' : 'NOT advertised'}${already}; ` +
              `${offers} migration offer(s) initiated to eligible e2e contact(s).`,
          );
        },
      ),
  );

  server.tool(
    'set_persona',
    "Set the bound identity's local operating contract (persona, free text). The " +
      'persona is how the agent behaves when it adopts this identity; it is NEVER shared ' +
      'via invites — only via the control-plane cluster registry. An agent must ask the ' +
      'user before adopting a persona. Empty string clears it.',
    { persona: z.string().describe('The new persona text (empty string clears it).') },
    async ({ persona }) =>
      runTool(
        ctxFor(),
        (ctx) => setPersona(ctx, { persona }),
        // persona is local-only and never carried in invites: no root-profile refresh (unlike set_bio).
        (r) => textResult(`Updated the persona of "${r.identity}".`),
      ),
  );
}
