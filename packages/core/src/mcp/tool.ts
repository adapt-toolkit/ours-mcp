// The adapter every converted tool handler goes through.
//
// The carrier is an `OursClient`: a handler calls the same operation one HTTP hop
// away, with the context dropped. Method names and argument types are DERIVED
// from the SDK's src/api/*, so a wrong name is a compile error, not a 404 —
// which is why there is no tool-name → operation mapping table, and why one must
// never be added.
import { OursError } from '@ours.network/sdk';
import type { OursClient } from '@ours.network/sdk';

/** The MCP content shape every ours tool returns. Was `index.ts:3458`. */
// A TYPE ALIAS, NOT AN INTERFACE, AND THAT IS NOT A STYLE CHOICE.
// `server.tool()`'s callback must return something assignable to the MCP SDK's
// CallToolResult, which carries an `[x: string]: unknown` index signature.
// TypeScript gives an implicit index signature to an object type ALIAS and to an
// inferred type, but NEVER to an interface — so declaring this as an interface
// makes every single registration fail with TS2769 "Index signature for type
// 'string' is missing in type 'McpTextResult'". The baseline never met this
// because index.ts:3458's textResult declares no return type at all and its
// inferred type is assignable. Both Developer-4 and Developer-5 hit it
// independently on their first compile; do not "tidy" it back to an interface.
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
let boundIdentity: string | null = null;
export function rememberBinding(name: string): void { boundIdentity = name; }
/** What runTool has learned. The inbox watch reads this rather than asking again. */
export function getBoundIdentity(): string | null { return boundIdentity; }
export function forgetBinding(): void { boundIdentity = null; }

async function reassertBinding(client: OursClient): Promise<boolean> {
  if (!boundIdentity) return false;
  try {
    await client.chooseIdentity({ name: boundIdentity, force: false });
    return true;
  } catch {
    boundIdentity = null; // genuinely gone, or held elsewhere — fail closed
    return false;
  }
}

export async function runTool<T>(
  client: OursClient,
  call: (client: OursClient) => Promise<T> | T,
  render: (value: T) => McpTextResult | Promise<McpTextResult>,
): Promise<McpTextResult> {
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
  if (boundIdentity === null) {
    void client.currentIdentity().then((r) => { boundIdentity = r.name; }).catch(() => {});
  }
  return render(value);
}
