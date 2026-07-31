// Pure unit test for the list_contacts duplicate-name marker (dist/contacts.js).
// The marker is defense in depth: post-fix books cannot normally hold duplicates
// (register_contact suffixes, the import sweep heals), so the rendering is pinned
// here rather than through a daemon that can no longer produce the state.
import { buildContactLines, duplicateNameCounts } from '../dist/contacts.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓', m)) : (fail++, console.log('  ✗ FAIL:', m)); };

const A = 'A'.repeat(64);
const B = 'B'.repeat(64);
const C = 'C'.repeat(64);

const lines = buildContactLines([
  { name: 'R', container_id: A },
  { name: 'R', container_id: B, degradedQueued: 2 },
  { name: 'S', container_id: C, rootTag: '  [role "S" of Root]' },
]);

ok(lines.length === 3, 'one line per contact');
ok(/DUPLICATE NAME/.test(lines[0]) && /DUPLICATE NAME/.test(lines[1]), 'both holders of a shared name carry the duplicate marker');
ok(!/DUPLICATE NAME/.test(lines[2]), 'a unique name carries no marker');
ok(/rename_contact/.test(lines[0]) && /container id/.test(lines[0]), 'the marker points at rename_contact and cid addressing');
ok(/keys pending restore \(2 queued\)/.test(lines[1]), 'the degraded marker still renders beside the duplicate marker');
ok(/\[role "S" of Root\]/.test(lines[2]), 'the root tag still renders');
ok(duplicateNameCounts([{ name: 'R', container_id: A }]).get('R') === 1, 'counts: single holder counts once');

console.log(`\ncontact-lines: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
