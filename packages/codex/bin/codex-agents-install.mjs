#!/usr/bin/env node
// Appends a sentinel-guarded pointer block to ~/.codex/AGENTS.md — safely and idempotently.
//
// Codex has no skill auto-selection guarantee and no SessionStart hook, so we drop a
// SECONDARY pointer into the global AGENTS.md (which Codex reads every session): it tells
// the agent the `ours` skill + MCP tools exist and to check get_messages when it goes live
// or expects a reply. Markdown is line-oriented, so appending our block at EOF is always
// safe; the sentinel makes a second run a no-op. Create the file if it does not exist.
//
// Pure functions (planAgentsInstall / renderAgentsBlock) are unit-tested; main() does the
// file IO. Zero dependencies.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SENTINEL = '<!-- >>> ours.network plugin (managed block) -->';
const SENTINEL_END = '<!-- <<< ours.network plugin -->';

// Decide how to install given the current AGENTS.md text. Appends unless our sentinel
// is already present (idempotent). Empty/missing file -> write a fresh one.
export function planAgentsInstall(text) {
  const t = text ?? '';
  if (t.includes(SENTINEL)) return { action: 'noop', reason: 'ours pointer already present' };
  if (!t.trim()) return { action: 'write', reason: 'no existing AGENTS.md' };
  return { action: 'append', reason: 'safe to append the ours pointer at EOF' };
}

// Render the managed AGENTS.md pointer: a short, honest note that ours exists and how to
// reach it. This is a POINTER, not the skill — the skill (with full instructions) lives
// under ~/.agents/skills/ours. Reactivity here is session-only by design.
export function renderAgentsBlock() {
  return `${SENTINEL}
## ours.network — secure agent-to-agent messaging

You have the **ours** skill (at \`~/.agents/skills/ours/SKILL.md\`) and the **ours** MCP
server (tools appear under the \`ours\` server, e.g. \`get_messages\`, \`send_message\`,
\`choose_identity\`). ours gives you self-sovereign identities and end-to-end-encrypted
channels to other agents and people over ADAPT.

- When the user mentions ours, identities, invites, contacts, sending/reading messages
  or files, or "check my mail" — read the \`ours\` skill and act.
- **Reactivity is session-only:** Codex has no background wake for ours. So **check
  \`get_messages\` when you go live and again whenever you expect a reply**; the daemon
  holds mail until you next read it. (An optional, non-native \`codex exec\` connector
  fallback exists — see the ours skill — but it is not native Codex reactivity.)
- Bind explicitly with \`choose_identity\` before sending or reading; never adopt an
  identity's persona without asking the user first.
${SENTINEL_END}
`;
}

function main() {
  const agentsPath = process.env.CODEX_AGENTS || join(homedir(), '.codex', 'AGENTS.md');
  const existing = existsSync(agentsPath) ? readFileSync(agentsPath, 'utf8') : '';
  const block = renderAgentsBlock();
  const plan = planAgentsInstall(existing);

  if (plan.action === 'noop') {
    console.log(`ours: AGENTS.md already has the ours pointer (${agentsPath}); nothing to do.`);
    return;
  }
  mkdirSync(dirname(agentsPath), { recursive: true });
  const next = plan.action === 'write' ? block : existing.replace(/\s*$/, '\n\n') + block;
  writeFileSync(agentsPath, next);
  console.log(`ours: ${plan.action === 'write' ? 'wrote' : 'appended ours pointer to'} ${agentsPath}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
