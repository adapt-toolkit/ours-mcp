// packages/core/src/inbox.ts
//
// Daemon-side derivation of the per-message TRANSPORT / ENCRYPTION type for the
// get_messages JSON payload (#owner-request 2026-07-17). PURE + side-effect free
// so it unit-tests standalone (test/inbox-encryption.test.mjs imports ../dist/inbox.js).
//
// WHY daemon-only (no core .mm/.mu touch): the core already emits distinct notify
// events on the two receive routes, and BOTH carry (or can be joined by) the
// sender-stamped `wire_id`:
//   • LEGACY box  → on_message_received hook → `message_received` notify.
//   • E2E / double-ratchet (migrated OR already-e2e pair) → the SAME
//     on_message_received hook (so a `message_received` ALSO fires) PLUS a
//     `e2e_app_recv` notify carrying { wire_id, session_id } (a2a_messaging.mm
//     mig_e2e_deliver_tail). The e2e wire_id == the stored inbox message's
//     wire_id (both are the decoded inner `iv $wire_id`).
// So: a message whose wire_id appears in ANY e2e receive notify arrived over the
// double-ratchet path ⇒ "e2e"; otherwise it is a legacy box ⇒ "legacy". No core
// change, no msg_id↔wire_id bridge needed (the inbox record already has wire_id).

export type EncryptionType = 'legacy' | 'e2e';

// Notify-log events whose wire_id proves an E2E/double-ratchet RECEIVE happened.
//   e2e_app_recv            — inbound app msg decrypted over the migrated session (the receive proof).
//   migration_deferred_flush— a queued msg re-driven as e2e on active (delivered over the ratchet).
// (e2e_app_send / migration_active are SEND/lifecycle, not a receive of THIS msg — excluded.)
const E2E_RECV_EVENTS = new Set(['e2e_app_recv', 'migration_deferred_flush']);

// Scan daemon notify events and collect the set of wire_ids that arrived e2e.
// Tolerant of the log's mixed event shapes; ignores empty/missing wire_ids
// (an "" wire_id can't be matched to a specific message and must not colour one).
export function e2eWireIdsFromEvents(events: Array<Record<string, unknown>>): Set<string> {
  const out = new Set<string>();
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    const event = ev.event;
    if (typeof event !== 'string' || !E2E_RECV_EVENTS.has(event)) continue;
    const wire = ev.wire_id;
    if (typeof wire === 'string' && wire.length > 0) out.add(wire);
  }
  return out;
}

// Derive the transport for one message. A non-empty wire_id present in the e2e
// receive set ⇒ "e2e"; everything else (legacy box, or no wire_id to join on) ⇒ "legacy".
export function encryptionFor(wireId: string | undefined | null, e2eWireIds: Set<string>): EncryptionType {
  return wireId && e2eWireIds.has(wireId) ? 'e2e' : 'legacy';
}

// The ALWAYS-JSON get_messages payload shape (owner: "всегда JSON, всегда payload это JSON").
// Keeps the raw `text` accessible (existing consumers) and adds `from` + `encryption`.
export type MessageJson = {
  msg_id: number;
  wire_id: string;
  from: { id: string; name: string };
  encryption: EncryptionType;
  transport: 'double_ratchet' | 'legacy_box'; // human-facing synonym of `encryption`
  text: string;
  date: string;
  status: string;
  reply_to: { wire_id: string; sentence?: number } | null;
};

// Minimal structural view of a rendered inbox message (matches index.ts InboxMsg).
export type InboxLike = {
  msg_id: number;
  sender_id: string;
  sender_name: string;
  text: string;
  date: string;
  status: string;
  wire_id: string;
  reply_to: { wire_id: string; sentence?: number } | null;
};

export function toMessageJson(m: InboxLike, e2eWireIds: Set<string>): MessageJson {
  const encryption = encryptionFor(m.wire_id, e2eWireIds);
  return {
    msg_id: m.msg_id,
    wire_id: m.wire_id,
    from: { id: m.sender_id, name: m.sender_name },
    encryption,
    transport: encryption === 'e2e' ? 'double_ratchet' : 'legacy_box',
    text: m.text,
    date: m.date,
    status: m.status,
    reply_to: m.reply_to,
  };
}

// Build the top-level get_messages JSON envelope (always an object, always
// `messages: MessageJson[]`, even when empty — the payload is ALWAYS structured JSON).
export function buildMessagesPayload(
  msgs: InboxLike[],
  e2eWireIds: Set<string>,
): { count: number; messages: MessageJson[] } {
  const messages = msgs.map((m) => toMessageJson(m, e2eWireIds));
  return { count: messages.length, messages };
}
