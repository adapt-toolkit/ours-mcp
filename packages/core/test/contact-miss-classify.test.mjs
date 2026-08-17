// packages/core/test/contact-miss-classify.test.mjs
//
// FLEET-004 regression. `resolve_contact` (core a2a_messaging.mm:876) aborts the
// whole send_message transaction on the FIRST send of any contact edge that does
// not exist yet; the daemon recovers by re-sending through auto-connect. Deciding
// whether an abort is that case was a bare `/Unknown contact/` substring test,
// which cannot tell "the contact I asked for is new" from "something else in this
// transaction named a contact I never asked about".
//
// The cases below are the measured 2026-08-17 series, verbatim from the ours
// daemon journal (journalctl --user, pid 11708), so the fixture text is the real
// abort shape — doubled "while executing transaction:" prefix and MUFL stack
// included — not an invented one.
//
// Like validate-name.test.mjs, importing dist/index.js starts the wrapper boot as
// a side effect, so assert synchronously and exit before that runs.
import assert from 'node:assert/strict';
import { classifyContactMiss } from '../dist/index.js';

const abort = (ref) =>
  'while executing transaction: while executing transaction: ' +
  `<a2a_messaging.mm:876/9-53> EVAL_ERROR: Unknown contact: ${ref}\n` +
  '<a2a_messaging.mm:876/9-53> note:  while evaluating this node\n' +
  '<a2a_messaging.mm:867/9-887/29> note:  while evaluating this node\n' +
  '<a2a_messaging.mm:1867/21-48> note:  while evaluating this node';

// ---- direction 1: established coordinator -> freshly spawned role -------------
// 11:03:36 and 11:03:47, FleetCoordinator's first two sends to Developer-4.
{
  const r = classifyContactMiss(abort('Developer-4'), 'Developer-4');
  assert.equal(r.miss, true, 'coordinator -> new role is a first-send miss');
  assert.deepEqual(r.refs, ['Developer-4']);
}

// ---- direction 2: freshly spawned role -> established coordinator -------------
// 10:58:56 (Developer-3) and 11:04:07 (Developer-4). The mission's central point:
// resolution fails in BOTH directions, because at a spawn neither side has the edge.
{
  const r = classifyContactMiss(abort('FleetCoordinator'), 'FleetCoordinator');
  assert.equal(r.miss, true, 'new role -> established coordinator is a first-send miss');
}

// ---- no spawn anywhere near it -----------------------------------------------
// 10:14:32, FleetRetrospector's first send to TrelloAdministrator: two standing
// roles, no spawn nearby, but the EDGE between them had never existed. Same path.
{
  const r = classifyContactMiss(abort('TrelloAdministrator'), 'TrelloAdministrator');
  assert.equal(r.miss, true, 'established -> established on a new edge is still a first-send miss');
}

// ---- the abandoned send: raw container id ------------------------------------
// 07:30:55, the only event of the 45 with no subsequent success. Classification
// still says "miss" — it is a genuine first-send miss — and the caller then finds
// no auto-connect path and must report NOT SENT rather than a bare failure.
{
  const cid = 'A1035F817FD22A249074057DC7246A431CCC807747FE10DD1FDD2028B3068872';
  const r = classifyContactMiss(abort(cid), cid);
  assert.equal(r.miss, true, 'a raw container id ref classifies as a miss');
  assert.deepEqual(r.refs, [cid]);
}

// ---- the bug: an abort naming a DIFFERENT contact -----------------------------
// send_message's forced monitoring copy fires send_encrypted_tx at monitoring_proxy,
// so a send to a perfectly ordinary contact can abort with "Unknown contact: <proxy>".
// The old substring test took the auto-connect path for the WRONG edge and swallowed
// the proxy fault; this must NOT be treated as a first-send miss.
{
  const proxy = '2FBE7AED8E18929891C4FB2A1A9CE35C2A1BC8A7EBEFCA5ED48E6BFC21E53D1F';
  const r = classifyContactMiss(abort(proxy), 'FleetCoordinator');
  assert.equal(r.miss, false, 'an abort naming the monitoring proxy is not a first-send miss');
  assert.deepEqual(r.refs, [proxy]);
}

// A mixed abort — one leg names the requested contact, another names something
// else — is also not a clean first-send miss.
{
  const text = `${abort('FleetCoordinator')}\n${abort('SomeOtherPeer')}`;
  const r = classifyContactMiss(text, 'FleetCoordinator');
  assert.equal(r.miss, false, 'a mixed abort is not a first-send miss');
  assert.deepEqual(r.refs, ['FleetCoordinator', 'SomeOtherPeer']);
}

// FAILS-BEFORE marker. This is the assertion that would not hold against the
// pre-FLEET-004 daemon: its predicate was `/Unknown contact/.test(String(e))`,
// which answers TRUE for the misdirected abort above and sends it to auto-connect.
{
  const proxy = '2FBE7AED8E18929891C4FB2A1A9CE35C2A1BC8A7EBEFCA5ED48E6BFC21E53D1F';
  const legacyPredicate = /Unknown contact/.test(abort(proxy));
  assert.equal(legacyPredicate, true, 'the old substring predicate accepted it');
  assert.equal(
    classifyContactMiss(abort(proxy), 'FleetCoordinator').miss,
    false,
    'the new classifier rejects what the old predicate accepted — this is the regression',
  );
}

// ---- unrelated failures must never reach auto-connect ------------------------
{
  const ambiguous =
    'while executing transaction: <a2a_messaging.mm:885/13-…> EVAL_ERROR: Contact name ' +
    '"Developer-1" is ambiguous - 2 contacts share it: AAA, BBB. Address the intended one ' +
    'by container id, or give it a unique name with rename_contact.';
  assert.equal(
    classifyContactMiss(ambiguous, 'Developer-1').miss,
    false,
    'the ambiguity abort must not take the auto-connect path (core warns at a2a_messaging.mm:862-864)',
  );
  assert.equal(classifyContactMiss('some other transaction failure', 'X').miss, false);
}

// ---- names may contain spaces ------------------------------------------------
// The composed root identity name is "<Human>@<host>", e.g. "Vitalii Shakhmatov@VPS",
// so the ref is the rest of the line, not the next whitespace-delimited token.
{
  const name = 'Vitalii Shakhmatov@VPS';
  const r = classifyContactMiss(abort(name), name);
  assert.equal(r.miss, true, 'a contact name containing spaces classifies correctly');
  assert.deepEqual(r.refs, [name]);
}

// ---- tolerance: "Unknown contact" with no parseable ref ----------------------
// Keep the pre-FLEET-004 behaviour rather than turning a working first send into
// a hard failure if the runtime ever changes the message shape.
{
  const r = classifyContactMiss('EVAL_ERROR: Unknown contact', 'Whoever');
  assert.equal(r.miss, true, 'an unparseable ref falls back to the permissive behaviour');
  assert.deepEqual(r.refs, []);
}

console.log('contact-miss-classify OK');
process.exit(0);
