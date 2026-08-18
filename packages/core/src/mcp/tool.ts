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
export async function runTool<T>(
  client: OursClient,
  call: (client: OursClient) => Promise<T> | T,
  render: (value: T) => McpTextResult | Promise<McpTextResult>,
): Promise<McpTextResult> {
  let value: T;
  try {
    value = await call(client);
  } catch (err) {
    // A catalogued failure crosses the hop as a real OursError with a byte-identical
    // message (client-parity). A TRANSPORT failure — 401, 404, dead daemon — is NOT
    // one and must not be laundered into catalogued prose.
    if (err instanceof OursError) return textResult(err.message, true);
    throw err; // a real bug or an outage — let the MCP layer surface it
  }
  return render(value);
}
