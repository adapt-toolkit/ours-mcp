// The adapter every converted tool handler goes through.
//
// ============================================================================
// THIS FILE IS THE CONVERSION CONTRACT. READ IT BEFORE CONVERTING A CALL SITE.
// ============================================================================
// A tool handler in ours-mcp now does exactly three things:
//
//   1. take its already-validated zod arguments,
//   2. call ONE `@ours.network/sdk` operation with the session's context,
//   3. render the typed result as MCP content.
//
// Everything between 1 and 3 — the engine, the packet transactions, the lease
// table, the error catalogue — is the SDK's. If a converted handler still
// contains a `withScopeAsync`, a `mutatingTx`, an `identities.get`, or a
// hand-built error string, the conversion is not finished.
//
// ----- WHY ERRORS ARE NOT HANDLED IN THE HANDLER --------------------------
// Every catalogued failure arrives as an `OursError` whose `.message` IS the
// baseline's tool text, byte for byte — that is the property ours-sdk's
// `test/api-error-parity.test.mjs` gates against the baseline source (65
// messages, 62 driven at their call sites). So the correct handling is to render
// `.message` and nothing else: no re-wording, no prefixing, no re-deriving a
// message from a code. `runTool` below does that once, so no handler repeats it.
//
// A NON-`OursError` is a bug, not a user-facing failure, and is deliberately
// rethrown rather than flattened into `isError: true` prose. The MCP server turns
// it into a protocol error, which is where an unexpected exception belongs.
//
// ----- THE CARRIER IS AN `OursClient`, NOT A `SessionContext` --------------
//
// THE HARD SWITCH IN ONE LINE: a handler used to call an SDK operation
// IN-PROCESS with the session's context; it now calls the SAME operation on an
// `OursClient`, one HTTP hop away, with the context dropped. `setBio(ctx, {bio})`
// became `client.setBio({bio})`. Nothing else about a handler changed — the tool
// names, descriptions, zod schemas and rendering are untouched, because those are
// what ours-mcp is for.
//
// The client's method names and argument types are DERIVED from the SDK's
// `src/api/*` signatures, so a typo or an operation that does not exist is a
// COMPILE error here rather than a 404 at runtime. That is why there is no
// mapping table between tool names and operations, and why one must never be
// added: one name for one thing across tool → method → route is what stops the
// two vocabularies from drifting.
//
// The carrier stays a FUNCTION (`clientFor()`) rather than a captured value for
// the same reason the context did: a handler must observe the process's current
// client, not one hoisted at registration time. The reason is weaker than it was
// — there is one client per process now, not a per-session context whose members
// are getters — but the shape costs nothing and removing it invites hoisting.
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
export async function runTool<T>(
  client: OursClient,
  call: (client: OursClient) => Promise<T> | T,
  render: (value: T) => McpTextResult | Promise<McpTextResult>,
): Promise<McpTextResult> {
  let value: T;
  try {
    value = await call(client);
  } catch (err) {
    // `instanceof` is STILL exact across the HTTP hop, and this is the property
    // the whole switch rests on. A catalogued failure comes back as HTTP 400
    // `{error:{code,message}}` and `OursClient` rethrows a REAL `OursError` —
    // same class, same code, byte-identical `.message` — which is exactly what
    // ours-sdk's test/client-parity.test.mjs drives both ways in one process and
    // compares. The class is one copy because the SDK ships `splitting: true`
    // across its published entries (test/cross-entry-singleton.test.mjs), so
    // there is no second `OursError` constructor to be an instance of instead.
    //
    // A TRANSPORT failure — 401, 404 for an unknown operation, an unparseable
    // body, a dead daemon — is deliberately NOT an OursError and falls through to
    // the rethrow below. That distinction is load-bearing: laundering "the daemon
    // is not there" into catalogued prose would put text on the wire that no
    // baseline gate has ever seen, and would read to an agent as a refusal it
    // could act on rather than an outage it cannot.
    if (err instanceof OursError) return textResult(err.message, true);
    throw err; // a real bug or an outage — let the MCP layer surface it
  }
  return render(value);
}

// `runToolSync` USED TO BE HERE AND IS GONE ON PURPOSE.
//
// It existed for the handful of operations that were synchronous in-process
// (`save_file`'s daemon-side notice). Across the API hop there is no such thing:
// every operation is a request. Keeping a "sync" wrapper that immediately awaits
// would be a name that lies about what the call costs, and the one thing a
// handler author most needs to know after this change is that every line marked
// `client.` is a round trip. It had no callers at the time of removal.
