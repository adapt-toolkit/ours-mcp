// The adapter every converted tool handler goes through.
//
// The carrier is an `OursClient`: a handler calls the same operation one HTTP hop
// away, with the context dropped. Method names and argument types are DERIVED
// from the SDK's src/api/*, so a wrong name is a compile error, not a 404 —
// which is why there is no tool-name → operation mapping table, and why one must
// never be added.
import { OursError } from '@ours.network/sdk';
import type { OursClient } from '@ours.network/sdk';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';

export type ToolRequestExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;
export type OursClientProvider = (extra: ToolRequestExtra) => OursClient | Promise<OursClient>;

/** The MCP content shape every ours tool returns. */
// A TYPE ALIAS, NOT AN INTERFACE, AND THAT IS NOT A STYLE CHOICE.
// `server.tool()`'s callback must return something assignable to the MCP SDK's
// CallToolResult, which carries an `[x: string]: unknown` index signature.
// TypeScript gives an implicit index signature to an object type ALIAS and to an
// inferred type, but NEVER to an interface — so declaring this as an interface
// makes every single registration fail with TS2769 "Index signature for type
// 'string' is missing in type 'McpTextResult'". Inferred object types are
// assignable for the same reason. Do not "tidy" this back to an interface.
export type McpTextResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError: boolean;
  structuredContent?: Record<string, unknown>;
};

export function textResult(text: string, isError = false): McpTextResult {
  return { content: [{ type: 'text' as const, text }], isError };
}

/**
 * Run one SDK operation and render its result.
 *
 * ```ts
 * server.tool('set_bio', DESC, { bio: z.string() }, async ({ bio }) =>
 *   runTool(clientFor(), (c) => c.setBio({ bio }), (r) =>
 *     textResult(`Bio updated for "${r.identity}".`)),
 * );
 * ```
 *
 * `render` may be async — some tools need a second read to build their prose —
 * but it must not perform engine work of its own, and it must not make a second
 * round trip it could have avoided.
 */
// ----- re-bind after a DAEMON restart -------------------------------------
//
// A daemon restart loses every lease: bindings.json is a CONTENT-FREE snapshot for
// offline hooks and deliberately does not record which SESSION held what
// (ours-sdk src/identity/lease.ts:52-56), so there is nothing to restore from and
// there should not be. The old proxy covered this by replaying a synthetic
// choose_identity; this covers it by remembering the name and re-asserting it once
// when a call comes back NOT_BOUND.
//
// IN MEMORY ONLY, and that is the whole difference from the deleted session-restore
// record: this case has a LIVE connector that knows what it bound, so nothing needs
// to outlive the process. The respawn case — connector dies, daemon lives — needs
// no help at all, because the lease token IS the session
// (test/lease-survives-respawn.test.mjs).
//
// Retrying is safe precisely because the call FAILED with NOT_BOUND: it did nothing,
// so there is no mutation to repeat. Only NOT_BOUND is retried, only once, and a
// refused re-bind clears the memory rather than looping.
const managedClients = new WeakSet<OursClient>();
/** Managed clients never bind or retry behind the supervisor recovery gate. */
export function markManagedClient(client: OursClient): void { managedClients.add(client); }

const boundIdentities = new WeakMap<OursClient, string>();
export function rememberBinding(client: OursClient, name: string): void { boundIdentities.set(client, name); }
/** What runTool has learned. The inbox watch reads this rather than asking again. */
export function getBoundIdentity(client: OursClient): string | null { return boundIdentities.get(client) ?? null; }
export function forgetBinding(client: OursClient): void { boundIdentities.delete(client); }

async function reassertBinding(client: OursClient): Promise<boolean> {
  if (managedClients.has(client)) return false;
  const boundIdentity = getBoundIdentity(client);
  if (!boundIdentity) return false;
  try {
    await client.chooseIdentity({ name: boundIdentity, force: false });
    return true;
  } catch {
    forgetBinding(client); // genuinely gone, or held elsewhere — fail closed
    return false;
  }
}

export async function runTool<T>(
  clientValue: OursClient | Promise<OursClient>,
  call: (client: OursClient) => Promise<T> | T,
  render: (value: T) => McpTextResult | Promise<McpTextResult>,
): Promise<McpTextResult> {
  const client = await clientValue;
  let value: T;
  try {
    value = await call(client);
  } catch (err) {
    // A daemon restart shows up here as NOT_BOUND on an ordinary call.
    if (err instanceof OursError && err.code === "NOT_BOUND" && await reassertBinding(client)) {
      try {
        return render(await call(client));
      } catch (retryErr) {
        if (retryErr instanceof OursError) return textResult(retryErr.message, true);
        throw retryErr;
      }
    }
    // A catalogued failure crosses the hop as a real OursError with a byte-identical
    // message (client-parity). A TRANSPORT failure — 401, 404, dead daemon — is NOT
    // one and must not be laundered into catalogued prose.
    if (err instanceof OursError) return textResult(err.message, true);
    throw err; // a real bug or an outage — let the MCP layer surface it
  }
  // LEARN THE BOUND NAME, ONCE, FROM THE ONLY SOURCE THAT CANNOT DRIFT: the daemon.
  // Fire-and-forget and only while we do not know it, so a bound session pays
  // nothing. This is what feeds reassertBinding above, and it is deliberately NOT a
  // list of which tools rebind — that list would be a second vocabulary, and it
  // would be wrong the first time an operation started or stopped binding.
  if (!managedClients.has(client) && getBoundIdentity(client) === null) {
    void client.currentIdentity().then((r) => { rememberBinding(client, r.name); }).catch(() => {});
  }
  return render(value);
}
