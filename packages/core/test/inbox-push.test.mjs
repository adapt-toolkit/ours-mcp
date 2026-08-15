// packages/core/test/inbox-push.test.mjs
// THE TWO INBOX PUSHES, AND THE TWO WAYS EITHER ONE CAN FAIL.
//
// `test/resource-updated.test.mjs` proves the chain end to end against a real
// client, which is the right test for "does a notification arrive". It cannot
// prove the two properties below, because neither is reachable from a healthy
// client:
//
//   1. BOTH pushes fire, not one. The conversion onto @ours.network/sdk dropped
//      `sendLoggingMessage` and kept `sendResourceUpdated`. A client that watches
//      only resources sees no difference at all — which is why the loss survived
//      a full green suite.
//   2. A push that REJECTS does not become an unhandled rejection. serve.ts used
//      `try { void p() } catch {}`, which cannot see a rejection: the promise
//      settles after the try block has exited, and Node >= 15 exits the process.
//      A live client cannot be made to reject on demand; a fake can.
//
// Drives dist/push.js — the REAL shipped module, not a copy — the same way
// files-helpers / inbox-encryption / contact-lines drive theirs.
import assert from 'node:assert/strict';
import { pushInboxNotifications } from '../dist/push.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓', m)) : (fail++, console.log('  ✗ FAIL:', m)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Any unhandled rejection anywhere in this file is a FAILURE, not a warning —
// that is the whole subject of the second half. Registered before the first push.
const unhandled = [];
process.on('unhandledRejection', (reason) => { unhandled.push(reason); });

const URI = 'ours://inbox/Alice';
const SUMMARY = '[Alice] new message from Bob (#7)';

// ── 1. both channels are used, with the baseline's payloads ──────────────────
{
  const calls = [];
  const target = {
    sendLoggingMessage: (p) => { calls.push(['log', p]); },
    server: { sendResourceUpdated: (p) => { calls.push(['res', p]); } },
  };
  const errs = [];
  pushInboxNotifications(target, URI, SUMMARY, (what, err) => errs.push([what, err]));

  ok(calls.length === 2, `both channels are pushed (saw ${calls.length})`);
  ok(calls[0]?.[0] === 'log' && calls[1]?.[0] === 'res',
    'the summary goes first, then the resource invalidation (baseline index.ts:2168-2176 order)');
  assert.deepEqual(calls[0]?.[1], { level: 'info', logger: 'ours', data: SUMMARY });
  ok(true, 'the logging payload is the baseline\'s {level:"info", logger:"ours", data:summary}');
  assert.deepEqual(calls[1]?.[1], { uri: URI });
  ok(true, 'the resource payload carries the per-identity inbox uri');
  ok(errs.length === 0, 'a healthy target reports no errors');
}

// ── 2. a SYNCHRONOUS throw in one push does not suppress the other ───────────
{
  let resourceSent = false;
  const target = {
    sendLoggingMessage: () => { throw new Error('transport is gone'); },
    server: { sendResourceUpdated: () => { resourceSent = true; } },
  };
  const errs = [];
  pushInboxNotifications(target, URI, SUMMARY, (what, err) => errs.push([what, String(err)]));

  ok(resourceSent, 'a throwing logging push still leaves the resource update sent');
  ok(errs.length === 1 && errs[0][0] === 'sendLoggingMessage' && /transport is gone/.test(errs[0][1]),
    'the synchronous failure is reported to the sink, naming which push failed');
}

// ── 3. …in the other direction too ───────────────────────────────────────────
{
  let logged = false;
  const target = {
    sendLoggingMessage: () => { logged = true; },
    server: { sendResourceUpdated: () => { throw new Error('session closed'); } },
  };
  const errs = [];
  pushInboxNotifications(target, URI, SUMMARY, (what, err) => errs.push([what, String(err)]));

  ok(logged, 'a throwing resource push does not stop the summary that ran before it');
  ok(errs.length === 1 && errs[0][0] === 'sendResourceUpdated',
    'and it is reported under its own name');
}

// ── 4. a REJECTED promise is absorbed, not left unhandled ────────────────────
// The property the old `try { void p() } catch {}` did not have.
{
  const target = {
    sendLoggingMessage: () => Promise.reject(new Error('client vanished mid-send')),
    server: { sendResourceUpdated: () => Promise.reject(new Error('sse stream closed')) },
  };
  const errs = [];
  pushInboxNotifications(target, URI, SUMMARY, (what, err) => errs.push([what, String(err)]));

  // Rejections settle on the microtask queue; an unhandledRejection is reported a
  // macrotask later. Both need a turn of the loop before this can be judged.
  await sleep(50);

  ok(errs.length === 2, `both rejections reached the sink (saw ${errs.length})`);
  ok(errs.some(([w, e]) => w === 'sendLoggingMessage' && /client vanished/.test(e)),
    'the logging rejection is reported under its own name');
  ok(errs.some(([w, e]) => w === 'sendResourceUpdated' && /sse stream closed/.test(e)),
    'the resource rejection is reported under its own name');
  ok(unhandled.length === 0,
    `NO unhandled rejection escaped (saw ${unhandled.length}: ${unhandled.map(String).join(' | ')})`);
}

// ── 5. a non-promise return is not mistaken for one ──────────────────────────
// An older MCP server whose send returns void must not be `.then`ed.
{
  const target = {
    sendLoggingMessage: () => undefined,
    server: { sendResourceUpdated: () => undefined },
  };
  const errs = [];
  assert.doesNotThrow(() => pushInboxNotifications(target, URI, SUMMARY, (w, e) => errs.push([w, e])));
  await sleep(20);
  ok(errs.length === 0 && unhandled.length === 0, 'void-returning sends are handled without error');
}

console.log(`\ninbox-push: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
