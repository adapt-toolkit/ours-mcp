// packages/core/test/inbox-encryption.test.mjs
//
// TASK A (owner 2026-07-17): get_messages returns an ALWAYS-JSON payload where each
// message carries `from` {id,name} + `encryption` — "legacy" for a legacy box,
// "e2e" for the double-ratchet (migrated / already-e2e) path — so you can ask an
// agent "how did you receive this". The encryption type is derived DAEMON-SIDE by
// joining the message wire_id against the E2E receive notify events. Pure-module
// unit test (mirrors files-helpers.test.mjs): imports ../dist/inbox.js.

import assert from 'node:assert/strict';
import {
  e2eWireIdsFromEvents,
  encryptionFor,
  toMessageJson,
  buildMessagesPayload,
} from '../dist/inbox.js';

// A realistic notify-log event stream: one legacy arrival (message_received only)
// and one e2e arrival (e2e_app_recv carrying its wire_id — the double-ratchet proof).
const events = [
  { event: 'message_received', from: 'Alice', msg_id: 1, date: '2026-07-17T10:00:00Z' },
  { event: 'e2e_app_recv', cid: 'cid-bob', session_id: 'deadbeef', ok: true, wire_id: 'wire-e2e-1' },
  { event: 'message_received', from: 'Bob', msg_id: 2, date: '2026-07-17T10:01:00Z' },
  // a migration flush also proves e2e delivery
  { event: 'migration_deferred_flush', cid: 'cid-bob', wire_id: 'wire-e2e-2' },
  // send/lifecycle events must NOT colour a received message
  { event: 'e2e_app_send', cid: 'cid-bob', session_id: 'deadbeef', olm_type: '1', wire_id: 'wire-SENT' },
  { event: 'migration_active', cid: 'cid-bob', role: 'initiator' },
  // an empty wire_id can't be joined and must be ignored
  { event: 'e2e_app_recv', cid: 'cid-x', ok: false, wire_id: '' },
];

const e2e = e2eWireIdsFromEvents(events);
assert.ok(e2e.has('wire-e2e-1'), 'e2e_app_recv wire_id collected');
assert.ok(e2e.has('wire-e2e-2'), 'migration_deferred_flush wire_id collected');
assert.ok(!e2e.has('wire-SENT'), 'e2e_app_send (a SEND) is not a receive proof');
assert.ok(!e2e.has(''), 'empty wire_id is never collected');
assert.equal(e2e.size, 2, 'exactly the two e2e-received wire_ids');

// Per-message derivation.
assert.equal(encryptionFor('wire-e2e-1', e2e), 'e2e', 'e2e wire_id ⇒ e2e');
assert.equal(encryptionFor('wire-legacy-1', e2e), 'legacy', 'unknown wire_id ⇒ legacy');
assert.equal(encryptionFor('', e2e), 'legacy', 'no wire_id to join ⇒ legacy');
assert.equal(encryptionFor(undefined, e2e), 'legacy', 'missing wire_id ⇒ legacy');

// The two stored inbox messages: a legacy box and a migrated e2e message. BOTH
// have sender info; the e2e one has a wire_id present in the e2e set.
const legacyMsg = {
  msg_id: 1,
  sender_id: 'id-alice',
  sender_name: 'Alice',
  text: 'hello over the legacy box',
  date: '2026-07-17T10:00:00Z',
  status: 'unread',
  wire_id: 'wire-legacy-1',
  reply_to: null,
};
const e2eMsg = {
  msg_id: 2,
  sender_id: 'id-bob',
  sender_name: 'Bob',
  text: 'hello over the double ratchet',
  date: '2026-07-17T10:00:05Z',
  status: 'unread',
  wire_id: 'wire-e2e-1',
  reply_to: { wire_id: 'wire-legacy-1' },
};

// A LEGACY message shows encryption "legacy", WITH sender.
const jLegacy = toMessageJson(legacyMsg, e2e);
assert.equal(jLegacy.encryption, 'legacy', 'legacy message ⇒ encryption "legacy"');
assert.equal(jLegacy.transport, 'legacy_box', 'legacy transport synonym');
assert.deepEqual(jLegacy.from, { id: 'id-alice', name: 'Alice' }, 'legacy carries from{id,name}');
assert.equal(jLegacy.text, 'hello over the legacy box', 'text preserved for existing consumers');

// An E2E (migrated) message shows encryption "e2e", WITH sender.
const jE2e = toMessageJson(e2eMsg, e2e);
assert.equal(jE2e.encryption, 'e2e', 'migrated message ⇒ encryption "e2e"');
assert.equal(jE2e.transport, 'double_ratchet', 'e2e transport synonym');
assert.deepEqual(jE2e.from, { id: 'id-bob', name: 'Bob' }, 'e2e carries from{id,name}');
assert.equal(jE2e.text, 'hello over the double ratchet', 'e2e text preserved');
assert.deepEqual(jE2e.reply_to, { wire_id: 'wire-legacy-1' }, 'reply_to passed through');

// The get_messages envelope is ALWAYS structured JSON with a messages[] array.
const payload = buildMessagesPayload([legacyMsg, e2eMsg], e2e);
assert.equal(payload.count, 2, 'count reflects messages');
assert.equal(payload.messages.length, 2);
assert.equal(payload.messages[0].encryption, 'legacy');
assert.equal(payload.messages[1].encryption, 'e2e');
// round-trips as JSON (this is what get_messages emits as its text payload).
const round = JSON.parse(JSON.stringify(payload));
assert.equal(round.messages[1].from.name, 'Bob');
assert.equal(round.messages[1].encryption, 'e2e');

// Empty inbox is STILL structured JSON (never bare text).
const empty = buildMessagesPayload([], e2e);
assert.deepEqual(empty, { count: 0, messages: [] }, 'empty inbox ⇒ {count:0,messages:[]}');

console.log('inbox-encryption OK');
