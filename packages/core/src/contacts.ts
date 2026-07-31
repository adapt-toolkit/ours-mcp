// Pure contact-list rendering helpers (no daemon state) — kept standalone, like
// files.ts / inbox.ts, so the unit test can import ../dist/contacts.js directly.

export interface ContactLineInput {
  name: string;
  container_id: string;
  /** pre-rendered root-linkage tag, e.g. `  [role "PeerOne" of BookKeeper]` */
  rootTag?: string;
  /** queued-restore count when the contact's keys are degraded */
  degradedQueued?: number;
  /** the shared name this contact held before the boot import sweep renamed it */
  renamedFrom?: string;
}

// Names shared by 2+ contacts (a pre-uniqueness book, or state slipped past the
// register_contact gate): sending to such a name aborts in the resolver, so every
// holder gets a loud marker pointing at the repair.
export function duplicateNameCounts(items: ContactLineInput[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const c of items) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
  return counts;
}

export function buildContactLines(items: ContactLineInput[]): string[] {
  const counts = duplicateNameCounts(items);
  return items.map(
    (c) =>
      `• ${c.name} — ${c.container_id}${c.rootTag ?? ''}` +
      `${c.degradedQueued !== undefined ? ` — ⚠ keys pending restore (${c.degradedQueued} queued)` : ''}` +
      `${(counts.get(c.name) ?? 0) > 1 ? ' — ⚠ DUPLICATE NAME: sends to this name abort; address by container id, repair with rename_contact' : ''}` +
      `${c.renamedFrom !== undefined ? ` — ⚠ renamed on import (two contacts were named "${c.renamedFrom}"; do NOT assume the one keeping the bare name is the live one — verify by container id, settle with rename_contact)` : ''}`,
  );
}
