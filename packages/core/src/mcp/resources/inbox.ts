// The `ours://inbox` MCP RESOURCE — the one registration in index.ts that is not
// a tool, and the one the daemon flip would otherwise leave behind.
//
// Converted from index.ts:4094-4108 (baseline 22ffb646). It matters more than its
// fifteen lines suggest: its body at index.ts:4102 reads the engine DIRECTLY, so
// if it stayed in a gutted index.ts it would be a live reader of the OLD engine
// sitting beside 32 handlers on the new one — a duplicated-state seam that only
// shows itself when someone reads the inbox after a write and gets the wrong
// world. It also keeps renderInbox (index.ts:3213) and fmtMsg (index.ts:3544)
// alive, which is how the tree would end up with two fmtMsg, one per engine.
//
// WHY THIS FILE DOES NOT USE runTool
// runTool renders `McpTextResult` — the `{content, isError}` shape every TOOL
// returns. A resource returns `{contents: [{uri, mimeType, text}]}`, a different
// shape with no isError at all, so the tool adapter does not apply. The OursError
// discipline is kept by hand instead, and it is the only thing kept by hand: one
// `instanceof OursError` for the not-bound case, and a non-OursError rethrown as
// a protocol error exactly as runTool does.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { OursError } from '@ours.network/sdk';
import type { OursClient } from '@ours.network/sdk';

import { fmtMsg } from '../format.js';

/**
 * The per-identity resource URI. Baseline index.ts:2160, moved here VERBATIM.
 *
 * Exported because it has exactly TWO callers and they MUST agree: this resource,
 * and the `server.server.sendResourceUpdated({ uri: inboxResourceUri(name) })`
 * notification at index.ts:2174. A second copy that drifted would break live
 * inbox updates silently — the client would be told a URI it never subscribed to.
 * Developer-2: import this one at the sendResourceUpdated site rather than
 * keeping index.ts:2160.
 */
export const inboxResourceUri = (name: string) => `ours://inbox/${encodeURIComponent(name)}`;

export function registerInboxResource(server: McpServer, clientFor: () => OursClient): void {
  server.resource(
    'inbox',
    'ours://inbox',
    { description: 'Decrypted incoming messages for the bound identity — auto-notifies on new arrivals.' },
    async () => {
      const client = clientFor();
      // The baseline collapses ALL FOUR binding failures into one fixed sentence
      // and the generic 'ours://inbox' uri (index.ts:4100-4101) — it never renders
      // the specific error text the tools do. So the OursError is caught and
      // discarded on purpose here; only whether it threw is load-bearing.
      //
      // THIS IS THE ONE PLACE THE HARD SWITCH COSTS A SECOND ROUND TRIP, and it is
      // worth saying rather than hiding. In-process this was `requireBound(ctx).name`
      // — a map lookup. Over the API the bound identity's NAME is not a local fact,
      // so it takes a call, and `currentIdentity` is the call that answers it. The
      // alternative was to render the URI from a name this process cached at bind
      // time, which is exactly the kind of local shadow of daemon-owned state that
      // this whole change exists to remove: a rebind elsewhere would make the
      // resource announce a URI for an identity we no longer hold.
      //
      // It also lands on the right side of the failure: `currentIdentity` throws the
      // same four catalogued binding errors `requireBound` did, so the collapse
      // below is unchanged, not approximated.
      let boundName: string;
      try {
        boundName = (await client.currentIdentity()).name;
      } catch (err) {
        if (err instanceof OursError) {
          return {
            contents: [{ uri: 'ours://inbox', mimeType: 'text/plain', text: 'No identity bound to this session.' }],
          };
        }
        throw err;
      }
      // index.ts:4102 was `withScope((lt) => renderInbox(readonlyTx(id,
      // '::actor::list_incoming_messages', lt)))`. listIncomingMessages is that
      // same expression, wrapped in requireBound and the error catalogue. Note the
      // one difference the catalogue makes: a read failure now propagates as an
      // OursError ('list_incoming_messages failed: …') where the baseline
      // propagated the raw throw. Both surface as a protocol error from a
      // resource, which has no isError channel to report them on.
      const inbox = await client.listIncomingMessages();
      const text = inbox.length === 0
        ? 'Inbox is empty.'
        : `Inbox (${inbox.length}):\n${inbox.map((m) => fmtMsg(m)).join('\n')}`;
      return { contents: [{ uri: inboxResourceUri(boundName), mimeType: 'text/plain', text }] };
    },
  );
}
