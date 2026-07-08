// Tests for the Codex install planners:
//   - bin/codex-config-install.mjs: decides how to add [mcp_servers.ours] to
//     ~/.codex/config.toml WITHOUT ever defining the table twice:
//       no config / empty            -> write a fresh file
//       config without our table     -> safe to append at EOF
//       config already installed     -> noop (sentinel present)
//       config with [mcp_servers.ours] -> noop (already defined by hand / codex mcp add)
//   - bin/codex-agents-install.mjs: decides how to append the ours pointer to
//     ~/.codex/AGENTS.md:
//       no file / empty              -> write
//       file without our pointer     -> append
//       pointer already present      -> noop (idempotent via sentinel)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planTomlInstall, renderTomlBlock, SENTINEL as TOML_SENTINEL } from '../bin/codex-config-install.mjs';
import { planAgentsInstall, renderAgentsBlock, SENTINEL as AGENTS_SENTINEL } from '../bin/codex-agents-install.mjs';

const TOML_BLOCK = renderTomlBlock();
const AGENTS_BLOCK = renderAgentsBlock();

// --- config.toml (MCP server) ---

test('empty config -> write', () => {
  assert.equal(planTomlInstall('').action, 'write');
  assert.equal(planTomlInstall('   \n').action, 'write');
});

test('config without our table -> append', () => {
  const cfg = 'model = "gpt-5-codex"\n\n[mcp_servers.filesystem]\ncommand = "npx"\n';
  assert.equal(planTomlInstall(cfg).action, 'append');
});

test('already-installed config (sentinel present) -> noop', () => {
  const cfg = `model = "gpt-5-codex"\n\n${TOML_SENTINEL}\n[mcp_servers.ours]\ncommand = "ours-mcp"\n`;
  assert.equal(planTomlInstall(cfg).action, 'noop');
});

test('config already defines [mcp_servers.ours] (no sentinel) -> noop (never duplicate)', () => {
  const cfg = '[mcp_servers.ours]\ncommand = "ours-mcp"\nargs = ["proxy"]\n';
  assert.equal(planTomlInstall(cfg).action, 'noop');
});

test('rendered TOML block wires the ours MCP server + the sentinel', () => {
  assert.match(TOML_BLOCK, /^# >>> ours\.network plugin/m);
  assert.match(TOML_BLOCK, /^\[mcp_servers\.ours\]/m);
  assert.match(TOML_BLOCK, /command = "ours-mcp"/);
  assert.match(TOML_BLOCK, /args = \["proxy"\]/);
  assert.match(TOML_BLOCK, /# <<< ours\.network plugin/);
});

test('appending the TOML block after a config keeps the sentinel once', () => {
  const cfg = 'model = "gpt-5-codex"\n';
  const merged = cfg + '\n' + TOML_BLOCK;
  const n = merged.match(new RegExp(TOML_SENTINEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')).length;
  assert.equal(n, 1);
});

// --- AGENTS.md (pointer) ---

test('empty AGENTS.md -> write', () => {
  assert.equal(planAgentsInstall('').action, 'write');
  assert.equal(planAgentsInstall('  \n').action, 'write');
});

test('AGENTS.md without our pointer -> append', () => {
  const md = '# My project rules\n\nAlways run tests.\n';
  assert.equal(planAgentsInstall(md).action, 'append');
});

test('AGENTS.md with our pointer (sentinel present) -> noop', () => {
  const md = `# rules\n\n${AGENTS_SENTINEL}\n## ours.network\n`;
  assert.equal(planAgentsInstall(md).action, 'noop');
});

test('rendered AGENTS block names the ours skill, the tools, and session-only reactivity', () => {
  assert.match(AGENTS_BLOCK, /ours\.network/);
  assert.match(AGENTS_BLOCK, /~\/\.agents\/skills\/ours/);
  assert.match(AGENTS_BLOCK, /get_messages/);
  assert.match(AGENTS_BLOCK, /session-only/i);
  // honest: mentions the optional non-native fallback without claiming native wake
  assert.match(AGENTS_BLOCK, /codex exec/);
  assert.match(AGENTS_BLOCK, /not native/i);
});

test('appending the AGENTS block keeps the sentinel once', () => {
  const md = '# rules\n';
  const merged = md + '\n' + AGENTS_BLOCK;
  const n = merged.match(new RegExp(AGENTS_SENTINEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')).length;
  assert.equal(n, 1);
});
