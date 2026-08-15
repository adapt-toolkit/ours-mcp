// The two notification pushes ours-mcp makes for one inbox event, isolated from
// the daemon so they can be driven directly by a test.
//
// ============================================================================
// WHY THIS IS A MODULE AND NOT THREE LINES INSIDE serve.ts
// ============================================================================
// Two defects live here, and neither is visible from a passing daemon.
//
// 1. THERE ARE TWO PUSHES, NOT ONE. Baseline `index.ts:2168-2176` sent BOTH
//    `sendLoggingMessage` (the summary itself, on notifications/message) and
//    `sendResourceUpdated` (which only says "the inbox changed"). The conversion
//    kept the second and dropped the first — collateral of ours-sdk's
//    `McpServerLike` losing `sendLoggingMessage`, which the SDK indeed never
//    calls but ours-mcp did. `mcp/server.ts` still advertises
//    `capabilities: { logging: {} }`, so a client subscribes and then hears
//    nothing at all. Nothing errors; the daemon's own stderr line prints
//    identically either way.
//
// 2. `try { void p() } catch {}` DOES NOT CATCH A REJECTION. serve.ts's comment
//    said a client that has gone away "must not turn an inbound message into an
//    unhandled rejection in the daemon" — but a voided promise settles after the
//    try block has exited, so the catch never runs and Node (>= 15) takes the
//    process down on the unhandled rejection. Both halves have to be handled
//    explicitly: the synchronous throw AND the asynchronous rejection.
//
// Kept free of every SDK and MCP import on purpose, so `build.mjs` can emit it
// as a standalone `dist/push.js` and `test/inbox-push.test.mjs` can drive the
// REAL shipped function with fake servers — the same pattern as files.js,
// inbox.js and contacts.js.

/**
 * The two members of `McpServer` this file touches, described structurally so
 * nothing here has to import the MCP package. The real `McpServer` satisfies it.
 */
export interface InboxPushTarget {
  sendLoggingMessage(payload: { level: 'info'; logger: string; data: string }): unknown;
  server: { sendResourceUpdated(payload: { uri: string }): unknown };
}

/** Reported per failed push; the caller decides how to log it. */
export type PushErrorSink = (what: 'sendLoggingMessage' | 'sendResourceUpdated', err: unknown) => void;

/**
 * Fire one push and absorb BOTH of its failure modes. Returns nothing: a push is
 * best-effort by definition — the message is already persisted, and a session
 * that has gone away must never cost the daemon an inbound message.
 */
function settle(call: () => unknown, what: 'sendLoggingMessage' | 'sendResourceUpdated', onError: PushErrorSink): void {
  let out: unknown;
  try {
    out = call();
  } catch (err) {
    // The SYNCHRONOUS half: a torn-down transport can throw before it ever
    // returns a promise.
    onError(what, err);
    return;
  }
  // The ASYNCHRONOUS half. This is the one a try/catch cannot see.
  if (out && typeof (out as Promise<unknown>).then === 'function') {
    void (out as Promise<unknown>).then(undefined, (err) => onError(what, err));
  }
}

/**
 * Announce one inbox event on both channels, in the baseline's order: the
 * human-readable summary first, then the resource invalidation.
 *
 * The two are INDEPENDENT — a failure of either must not suppress the other,
 * which is why each gets its own `settle` rather than sharing one try block.
 */
export function pushInboxNotifications(
  target: InboxPushTarget,
  uri: string,
  summary: string,
  onError: PushErrorSink,
): void {
  settle(() => target.sendLoggingMessage({ level: 'info', logger: 'ours', data: summary }), 'sendLoggingMessage', onError);
  settle(() => target.server.sendResourceUpdated({ uri }), 'sendResourceUpdated', onError);
}
