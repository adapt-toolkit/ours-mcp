// packages/core/test/skill-tool-vocabulary.test.mjs
// EVERY MCP TOOL A SHIPPED SKILL TELLS AN AGENT TO CALL MUST ACTUALLY EXIST.
//
// This gate exists because of a failure that shipped: `feat!: drop the monitoring
// MCP tools with the daemon-side control plane` removed `bind_monitoring_proxy`
// and `get_monitoring_status` from the server, and all three shipped SKILL.md
// files went on instructing agents to call them — with argument objects, in
// numbered ceremonies, under trigger phrases in the frontmatter. Nothing failed:
// the packages that ship the skills have no dependency on the package that
// registers the tools, so no compiler, no linter and no test connected the two
// halves. The agent finds out at the call site, in front of a user.
//
// ----- WHY IT DERIVES BOTH SIDES INSTEAD OF LISTING THE TWO NAMES -----------
// A test that asserted "these two names are absent" would be satisfied for
// exactly one removal and then rot. Both sides are re-derived from source on
// every run, so the NEXT tool removal fails here the moment it lands, and a new
// tool needs no edit to this file at all.
//
// ----- WHAT COUNTS AS "TELLS AN AGENT TO CALL IT" --------------------------
// A snake_case identifier immediately followed by `(` — `get_messages()`,
// `send_message({ … })`. That is how every tool call is written in these
// documents, and prose mentions of a name are deliberately NOT matched, so a
// section can keep saying "`bind_monitoring_proxy` was removed" (which is a fact
// worth keeping) without ever reading as an instruction to call it.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKGS = join(HERE, '..', '..');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓', m)) : (fail++, console.log('  ✗ FAIL:', m)); };

// ----- side 1: what the ours MCP server actually registers -------------------
// Read from the registrars themselves — the same source `mcp/server.ts` wires up.
const toolsDir = join(HERE, '..', 'src', 'mcp', 'tools');
const registered = new Set();
for (const f of readdirSync(toolsDir).filter((n) => n.endsWith('.ts'))) {
  const src = readFileSync(join(toolsDir, f), 'utf8');
  for (const m of src.matchAll(/server\.tool\(\s*'([a-z_]+)'/g)) registered.add(m[1]);
}
ok(registered.size >= 25, `derived the registered tool set from src/mcp/tools/ (${registered.size} tools)`);

// ----- side 1b: tools a skill may name that belong to ANOTHER server ---------
// The Codex plugin ships its own `ours-monitor` MCP server, so its skill legally
// names tools this repo's core server does not register. Read from that server's
// exported list rather than hardcoded here, for the same reason as above.
const monitorSrc = readFileSync(join(PKGS, 'codex', 'src', 'monitor-mcp.mjs'), 'utf8');
const monitorNames = (monitorSrc.match(/export const monitorToolNames = \[([^\]]+)\]/) ?? [, ''])[1]
  .split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
ok(monitorNames.length > 0, `derived the codex monitor tool set (${monitorNames.join(', ')})`);

// Non-tool snake_case identifiers that are legitimately written call-shaped in
// these documents. Each one is a NON-MCP thing an agent invokes; keep this list
// as short as the documents allow.
const NOT_MCP_TOOLS = new Set([
  'choose_identity_force', // documented argument shape, not a tool name
]);

const allowed = new Set([...registered, ...monitorNames, ...NOT_MCP_TOOLS]);

// ----- side 2: what the shipped skills instruct ------------------------------
const SKILLS = ['claude-code', 'codex', 'hermes'].map((p) => ({
  pkg: p,
  path: join(PKGS, p, 'skills', 'ours', 'SKILL.md'),
}));

for (const { pkg, path } of SKILLS) {
  const text = readFileSync(path, 'utf8');
  const called = new Set();
  for (const m of text.matchAll(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\(/g)) called.add(m[1]);

  const missing = [...called].filter((n) => !allowed.has(n)).sort();
  ok(missing.length === 0,
    `${pkg}/skills/ours/SKILL.md calls only tools that exist` +
    (missing.length ? ` — MISSING: ${missing.join(', ')}. Either the tool was removed and the skill still tells agents to call it, or this gate needs the new tool's source.` : ''));
  ok(called.size > 5, `${pkg} skill was actually scanned (${called.size} call-shaped tool references)`);
}

// The frontmatter description is what decides whether the skill is loaded at all,
// so a trigger phrase for a removed capability summons the skill to say "no".
for (const { pkg, path } of SKILLS) {
  const front = readFileSync(path, 'utf8').split('---')[1] ?? '';
  const stale = [...front.matchAll(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\(/g)].map((m) => m[1]).filter((n) => !allowed.has(n));
  assert.deepEqual(stale, [], `${pkg} frontmatter names removed tools: ${stale.join(', ')}`);
  ok(true, `${pkg} frontmatter names no removed tool`);
}

console.log(`\nskill-tool-vocabulary: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
