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
// ----- WHY THE CONTEXT IS A FUNCTION, NOT A VALUE -------------------------
// `SessionContext`'s three members are getters, not fields, and that is
// load-bearing: an operation that rebinds mid-call (choose_identity,
// create_identity) must observe the lease table as it is NOW, not as it was when
// the request arrived. Capturing `leaseToken()` into a local at entry
// re-introduces exactly the staleness the SDK's own `/api/v1` bridge documents
// at `src/http/api-routes.ts:231`.
import { OursError } from '@ours.network/sdk';
import type { SessionContext } from '@ours.network/sdk';

/** The MCP content shape every ours tool returns. Was `index.ts:3458`. */
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
 *   runTool(ctxFor(), (ctx) => sdk.setBio(ctx, { bio }), (r) =>
 *     textResult(`Bio updated for "${r.identity}".`)),
 * );
 * ```
 *
 * `render` may be async — some tools need a second read to build their prose —
 * but it must not perform engine work of its own.
 */
export async function runTool<T>(
  ctx: SessionContext,
  call: (ctx: SessionContext) => Promise<T> | T,
  render: (value: T) => McpTextResult | Promise<McpTextResult>,
): Promise<McpTextResult> {
  let value: T;
  try {
    value = await call(ctx);
  } catch (err) {
    // `instanceof` is exact: the SDK ships one copy of its error class across all
    // three published entries (`splitting: true`, gated by ours-sdk's
    // test/cross-entry-singleton.test.mjs), so there is no second `OursError`
    // constructor for a thrown error to be an instance of instead.
    if (err instanceof OursError) return textResult(err.message, true);
    throw err; // a real bug — let the MCP layer surface it as a protocol error
  }
  return render(value);
}

/**
 * The same thing for the handful of operations that are synchronous and cannot
 * fail with anything but an `OursError` (`save_file`'s daemon-side notice).
 */
export async function runToolSync<T>(
  ctx: SessionContext,
  call: (ctx: SessionContext) => T,
  render: (value: T) => McpTextResult | Promise<McpTextResult>,
): Promise<McpTextResult> {
  return runTool(ctx, call, render);
}
