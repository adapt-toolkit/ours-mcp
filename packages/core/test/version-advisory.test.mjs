import { formatVersionAdvisory } from '../dist/index.js'; // re-exported (Step 3)
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓', m)) : (fail++, console.log('  ✗ FAIL:', m)); };
ok(formatVersionAdvisory({ selfVersion: '1.2.3', daemonVersion: '1.2.3' }) === null, 'equal versions → no advisory');
ok(formatVersionAdvisory({ selfVersion: '1.2.3', daemonVersion: null }) === null, 'unknown daemon → no advisory');
const a = formatVersionAdvisory({ selfVersion: '1.3.0', daemonVersion: '1.2.0' });
ok(typeof a === 'string' && a.includes('1.3.0') && a.includes('1.2.0'), 'mismatch → advisory names both versions');
ok(/ours-mcp stop/.test(a), 'advisory includes the manual upgrade step');
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
