# Contact-name uniqueness in ours-mcp

**Architect-2 · 2026-07-30 · spec, no code written.** Scope: ours-mcp. Read read-only at `849a355`; line numbers are a reading aid, file + function is the anchor.

## Orientation

An identity has a **container id** (64-hex, unique, permanent) and a **display name** (local, no uniqueness guarantee). `contacts` (`a2a_messaging.mm:99`) is keyed by container id, and `contact_t` is `($name, $container_id)` (`a2a_protocol.mm:14`), so two entries with the same name are structurally legal. Users address contacts by name. Everything follows from that mismatch.

## Incident

Coordinator's book held two contacts named `"Architect-1"` — the live agent and a dead predecessor in the same role slot. `send_message` by name returned success with a wire id and delivered to the dead one, twice, misdiagnosed as message loss; seven such pairs. The sender sees success, the intended recipient sees nothing, and the stale identity is a role under the same root, so if bound it reads mail meant for someone else. (Live-book details as reported; I did not read live contact state.)

## Owner decisions — his, not proposals

- **D1** — No path ever refuses a registration over a name collision.
- **D2** — Collisions take a filesystem-style ordinal suffix, ` 1`, ` 2`, ` 3`, migration sweep included.
- **D3** — The clean name stays with the first arrival; the newcomer takes the suffix.
- **D4** — Cross-book cleanup is deferred: real, but too complex now.

**Consequence of D3:** the retired predecessor keeps `Architect-1` and the live replacement becomes `Architect-1 1`, so a send to the bare name deterministically reaches the dead identity. The collision warning (P2) and `rename_contact` (P4) are the only mitigations.

## Problem 1 — a name matching two contacts resolves to one of them, silently

`resolve_contact` (`a2a_messaging.mm:469-478`) guards its scan with `found == NIL && (name matches || cid matches)`, so the first match wins and MUFL map iteration order decides which; `send_message`, `send_file` and `remove_contact` all resolve through it, so the cleanup tool is ambiguous too.

**Fix:** a container-id reference returns immediately; one name match returns; two or more abort, listing every candidate's container id. Mark shared names in `list_contacts` (`index.ts:3512`).

**Constraint:** keep `"Unknown contact: " + ref` unchanged, and keep that substring out of the new error — `index.ts:3824` tests `/Unknown contact/` to fall through to auto-connect, so an ambiguity error containing it would create a third contact.

**Working manual fix today:** a 64-hex container id can only match the cid branch, and container ids are the map key, so **addressing by container id is unambiguous by construction** and cannot misfire on any book. It is the only safe remedy on an unpatched daemon.

## Problem 2 — eleven write sites, none checks the name

Eleven reachable paths write into `contacts` — `a2a_messaging.mm:1570`, `:1496`, `:1444`, `:1360`, `:1168`, `:431` and `actor.mu:1963`, `:1854`, `:1017`, `:1219`, `:986` — and not one checks the name, so fixing `add_contact` alone leaves ten holes.

`sibling_introduce` (`actor.mu:1963`) is the one that caused the incident: it checks only the container id, so a respawned role with new keys and the same label writes a second entry, created by a remote party with no local action and no warning, on every respawn. Three of the eleven take the name from a remote party, making collision partly attacker-influenced.

**Fix:** one `register_contact (cid, desired)` helper in `a2a_messaging.mm` with all eleven routed through it — idempotent on a known container id, otherwise suffixed with the lowest free ordinal, never aborting, and warning every time with both container ids and a pointer to `rename_contact`. Contact names are unvalidated (`index.ts:3429`), so spaces and digits are legal. A twelfth write site cannot bypass a check it must call to write at all.

**Why D1 is no-refusal:** `add_contact` parks the chosen name (`a2a_messaging.mm:685`) and the contact is written only when handshake leg 3 arrives (`:1570`). **By the time the collision is visible the remote invite is already deleted** — `pending_invites` and `pending_invite_keys` go at **`a2a_messaging.mm:1500-1501`**. Refusing there does not protect a name, it loses a connection that cannot be re-established without a fresh out-of-band invite. The inbound paths carry a first message in the same transaction, so refusing would discard legitimate mail as well.

## Problem 3 — retiring an identity leaves its entry in every peer's book

`deleteIdentityCompletely` (`index.ts:952`) removes the packet, identity entry, host-local book entry, lease, root marker and disk, but touches no other identity's `contacts` map, so the stale entry outlives the identity in every book that knew it and collides with the next occupant of the name.

**Fix:** (a) `unpublishFromBook` (`index.ts:453`) deletes by name and `publishToBook` keys by name, so a same-named replacement published before teardown loses *its* entry — match on container id instead. (b) Correct the `remove_contact` documentation (`index.ts:3939-3941`). (c) Cross-book removal is deferred (D4).

**Proof for (b):** the doc says a removed peer revives through the contact book. There are two routes, and the undocumented one fires first — `findSibling` (`index.ts:710-717`) looks the name up in the host's identity map, ahead of `sendViaLocalBook` (`index.ts:739`). Removal is not retirement, published or not.

## Problem 4 — books that already contain collisions

There is no way to rename a contact anywhere in ours-mcp; the only route today is `remove_contact` plus re-add, and `remove_contact` is itself ambiguous under exactly this condition.

**Fix (a) — `rename_contact (contact, new_name)`:** resolves through the fixed resolver so it accepts a container id, rejects a name another contact holds, and rewrites `$name` in place; `peer_ads`, `contact_roots` and the encrypted channel are container-id-keyed, so an established session survives. Under D1 and D3 it is the only mechanism that ever puts a name on the intended contact, which is why it is Phase 1.

**Fix (b) — dedup on import** at `import_core_state` (`a2a_messaging.mm:1995`), which runs on every daemon boot via `restoreIdentity` (`index.ts:2542`), so books heal on the next restart with no migration tool. Group by name; one member keeps the bare name, the others take ` <n>`. Log every rename and mark it in `list_contacts`. Leave `core_format_version` at 1 (`a2a_messaging.mm:76`) and rescan unconditionally — its comment permits a bump only for a blob-*shape* change, and this changes content.

**Limit on (b):** `contact_t` is `($name, $container_id)` and nothing else, **so no arrival order exists**; the tie-break is lowest container id by byte order. **For a collision that already exists, which contact keeps the clean name is arbitrary with respect to which one is alive.** Nothing is deleted — both contacts, both channels and all history survive.

**Do not decide which duplicate is dead:** absence from `list_identities` (`index.ts:3309`) is normal for every remote peer, and `list_degraded_contacts` (`a2a_messaging.mm:1756-1773`) means keys need re-establishing, not death.

**Operator procedure.** Before this ships, address every call — `remove_contact` included — by container id, never by name. After it ships: restart, read `list_contacts`, and **do not assume the contact holding the bare name is the live one**. If it is not, **two `rename_contact` calls by container id** move the name off the stale contact and onto the live one — **recurring every time a role slot is reused**, until D4 is taken on.

## Phasing

Phases 1 and 2 ship together: Phase 2 alone leaves an ambiguous name with no repair tool.

| Phase | Contents |
|---|---|
| **1** | `rename_contact` (P4a) — prerequisite for the rest; the only way a name reaches the intended contact |
| **2** | `resolve_contact` ambiguity abort with the `Unknown contact` string preserved, plus the duplicate marker (P1) — the security fix |
| **3** | `register_contact` helper, all eleven sites routed through it, ordinal suffixing, collision warnings (P2) |
| **4** | Dedup-on-import sweep, same ordinal scheme (P4b) — heals existing books; depends on Phase 3's rule |
| **5** | Container-id-matched `unpublishFromBook`, corrected `remove_contact` docs (P3) |

## Deferred — cross-book cleanup (D4)

Two mechanisms would clear a retired identity from other books: a host-side sweep in `deleteIdentityCompletely` matching on container id only (matching by name would delete the live replacement, and it must skip the bound control plane per the guard at `a2a_messaging.mm:887`), and a `farewell` announcement sent before teardown, the only thing that reaches off-host books.

Deferring is tolerable because Phases 3 and 4 make the collision visible rather than silent. It is not free: under D3 the stale entry keeps the bare name, so the warning is the only thing between an operator and a send that deterministically reaches the dead identity.

## Tests

1. Two contacts, same name, different container ids: `send_message` by name aborts naming both; by container id it succeeds to the intended one.
2. Same setup: `remove_contact` by name aborts rather than deleting a coin-flip entry.
3. **D1 regression** — `add_contact` against a taken name succeeds, registers as `"<name> 1"`, warns, leaves the invite intact. Assert no transaction aborts; this is the test a future contributor is most likely to break by tightening the check.
4. **The incident** — a second identity named `"R"` with a new container id sends A its first message via the sibling path: A holds two contacts, the newcomer is `"R 1"`, the original still `"R"`, the message arrived, the warning named both ids.
5. **The D3 consequence** — in that setup `send_message "R"` resolves to the original. Comment it as intended, not desired, behaviour.
6. Ordinals: with `"R"` and `"R 1"` present a third collision becomes `"R 2"`; an existing literal `"R 1"` is skipped, not clobbered.
7. Import a blob with two contacts named `"X"`: one holds `"X"`, the other `"X 1"`, stable across repeated imports, both container ids and `peer_ads` entries surviving.
8. `rename_contact` by container id during a collision succeeds and leaves the channel usable; renaming to a taken name is refused.
9. Retiring an identity does not collaterally delete a same-named replacement's book entry.

## Scope note

This makes ours-mcp safe against any caller that reuses a display name and does not assume ours-fleet will stop doing so, since a remote party's naming is never under this codebase's control. A fleet-side change giving respawned roles unique names would be complementary, not a substitute — though it would retire the fleet-respawn case, the largest source of these collisions here and the one where D3 and D4 leave the dead identity holding the clean name. That is a fleet decision.
