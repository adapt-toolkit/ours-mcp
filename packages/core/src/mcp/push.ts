// Body-free arrival logging, isolated so sync throws and async rejections from
// a disappearing MCP client can be driven directly by a test.
//
// Kept free of every SDK and MCP import on purpose, so `build.mjs` can emit it
// as a standalone `dist/push.js` and `test/inbox-push.test.mjs` can drive the
// REAL shipped function with fake servers — the same pattern as files.js,
// inbox.js and contacts.js.

/**
 * The member of `McpServer` this file touches, described structurally so
 * nothing here has to import the MCP package. The real `McpServer` satisfies it.
 */
export interface ArrivalPushTarget {
  sendLoggingMessage(payload: { level: 'info'; logger: string; data: string }): unknown;
}

/** Reported per failed push; the caller decides how to log it. */
export type PushErrorSink = (what: 'sendLoggingMessage', err: unknown) => void;

/**
 * Fire one push and absorb BOTH of its failure modes. Returns nothing: a push is
 * best-effort by definition — the message is already persisted, and a session
 * that has gone away must never cost the daemon an inbound message.
 */
function settle(call: () => unknown, what: 'sendLoggingMessage', onError: PushErrorSink): void {
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
 * Announce one body-free arrival summary on the logging channel.
 */
export function pushArrivalNotification(
  target: ArrivalPushTarget,
  summary: string,
  onError: PushErrorSink,
): void {
  settle(() => target.sendLoggingMessage({ level: 'info', logger: 'ours', data: summary }), 'sendLoggingMessage', onError);
}
