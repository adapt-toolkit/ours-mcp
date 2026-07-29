//
// SSE keepalive — keep long-lived streams from being killed by a client's
// inter-chunk read timeout.
//
// THE BUG THIS FIXES
// An SSE stream that stays quiet for 300s is killed CLIENT-side by undici's
// default inter-chunk bodyTimeout (300_000ms). Observed in the field as a
// metronome: 9 disconnects at 301/302/319/301/302/302/302/301s. Neither the MCP
// SDK's server transport nor its options provide a keepalive (there is no
// setInterval anywhere in server/streamableHttp.js, and the options type has no
// such field), so we emit SSE comment frames ourselves.
//
// WHY THIS LIVES IN OUR HTTP LAYER AND NOT IN THE SDK
// The SDK owns the ReadableStream controllers privately (_streamMapping).
// res.write is public Node API, and it is SAFE against frame corruption because
// the SDK's writeSSEEvent() builds a whole `event:…\ndata:…\n\n` string and does
// ONE controller.enqueue per frame — so a comment frame lands BETWEEN frames and
// can never split one. Clients ignore it twice over: eventsource-parser drops
// bare comment lines, and the SDK client separately skips no-data events
// ("priming events, keep-alives").
//
// *** DO NOT "FIX" THIS INSTEAD BY SETTING AN UNDICI DISPATCHER / bodyTimeout. ***
// That is the tempting change and it is the wrong direction. Raising or zeroing
// bodyTimeout would remove our ONLY detection of a black-holed connection: today
// a dead-but-not-closed TCP stream is noticed in 300s; with bodyTimeout off it is
// never noticed at all — trading a bounded false positive for an unbounded true
// negative. With keepalive traffic every 25s the 300s default STOPS being a bug
// and BECOMES a correct liveness detector, because 300s of silence then genuinely
// means dead. KEEPING THAT DEFAULT IS A DECISION, NOT AN OMISSION.
// A dispatcher would also only protect our own proxy; clients that reach this
// daemon through the MCP plugin (as other fleets' agents do) get nothing from it,
// whereas these frames fix the whole class.
//
// Mirror-image precedent in index.ts: httpServer.requestTimeout = 0, which
// disables Node's own 300s force-close of these same streams.
//

import type { ServerResponse } from 'node:http';

/** Default cadence: a 12x margin under the 300s inter-chunk timeout. */
export const DEFAULT_SSE_KEEPALIVE_MS = 25_000;

/** The comment frame. Payload is irrelevant; being a flushed body chunk is the point. */
export const KEEPALIVE_FRAME = ': ka\n\n';

/** Resolve the interval from the environment. 0 (or negative) disables. */
export function sseKeepaliveMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.OURS_SSE_KEEPALIVE_MS ?? '').trim();
  if (raw === '') return DEFAULT_SSE_KEEPALIVE_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_SSE_KEEPALIVE_MS;
}

/**
 * Emit keepalive comment frames on `res` once it becomes an SSE stream.
 * No-op for non-SSE responses, and self-cancelling when the response ends.
 *
 * Detecting "is SSE" by wrapping writeHead is deliberate: res.getHeader() does
 * NOT see headers passed as writeHead(status, obj) — it returns undefined,
 * verified — and @hono/node-server (which the MCP SDK's Node wrapper uses) sets
 * the SSE headers exactly that way. Reading them back would silently never match,
 * leaving a keepalive that looks armed and never fires.
 */
export function armSseKeepalive(res: ServerResponse, intervalMs: number = sseKeepaliveMs()): void {
  if (!(intervalMs > 0)) return;

  let isSse = false;
  const origWriteHead = res.writeHead.bind(res);
  res.writeHead = ((...args: unknown[]) => {
    // writeHead(status[, statusMessage][, headers]) — headers may be arg 1 or 2.
    const hdrs = (typeof args[1] === 'object' && args[1] !== null ? args[1] : args[2]) as
      | Record<string, unknown>
      | undefined;
    if (hdrs && !Array.isArray(hdrs)) {
      for (const [k, v] of Object.entries(hdrs)) {
        if (k.toLowerCase() === 'content-type' && String(v).includes('text/event-stream')) isSse = true;
      }
    }
    return (origWriteHead as (...a: unknown[]) => ServerResponse)(...args);
  }) as typeof res.writeHead;

  const timer = setInterval(() => {
    if (!isSse || res.writableEnded || res.destroyed) return;
    // Each write leaves as its own chunked-transfer chunk (verified on the wire:
    // a 6-byte comment arrives as `6\r\n: ka\n\n\r\n` at the interval, with no
    // coalescing), which is what resets the client's inter-chunk timer. An
    // unflushed comment sitting in a buffer would be indistinguishable from no
    // keepalive at all, which is why the test asserts arrival, not emission.
    try { res.write(KEEPALIVE_FRAME); } catch { /* stream gone; 'close' clears the timer */ }
  }, intervalMs);
  timer.unref?.();

  const stop = () => clearInterval(timer);
  res.once('close', stop);
  res.once('finish', stop);
}
