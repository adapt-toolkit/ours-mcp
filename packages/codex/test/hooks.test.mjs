import test from 'node:test';
import assert from 'node:assert/strict';
import { handleHook } from '../src/hooks/runner.mjs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test('SessionStart registers the thread and injects body-free unread context', async () => {
  const commands = [];
  const result = await handleHook({ hook_event_name: 'SessionStart', source: 'startup', session_id: 'thr', cwd: '/repo' }, {
    env: { OURS_CODEX_CONTROL_SOCKET: '/tmp/s', OURS_CODEX_CAPABILITY: 'cap', OURS_PORT: '4050', OURS_API_TOKEN: 'tok' },
    send: async (...args) => { commands.push(args); return { state: {} }; },
    fetch: async () => Response.json({ identities: [{ name: 'Alice', count: 2, recent: [{ from: 'Bob', msg_id: 1, date: 'today', body: 'SECRET' }] }] }),
    findPin: async () => ({ identity: 'Alice' }),
  });
  assert.equal(commands[0][2].command, 'register_session');
  const context = result.hookSpecificOutput.additionalContext;
  assert.match(context, /Alice.*2 unread/s);
  assert.doesNotMatch(context, /SECRET/);
  assert.match(context, /ask.*bind/i);
  assert.match(context, /ask.*monitor/i);
});

test('compact suppresses duplicate preamble and successful binding updates control', async () => {
  assert.deepEqual(await handleHook({ hook_event_name: 'SessionStart', source: 'compact' }, { env: {} }), { continue: true });
  const commands = [];
  const result = await handleHook({ hook_event_name: 'PostToolUse', tool_name: 'mcp__ours__choose_identity', tool_input: { name: 'Alice' }, tool_response: { isError: false } }, {
    env: { OURS_CODEX_CONTROL_SOCKET: '/tmp/s', OURS_CODEX_CAPABILITY: 'cap' }, send: async (...args) => { commands.push(args); return { state: {} }; },
  });
  assert.equal(commands[0][2].command, 'binding_changed');
  assert.deepEqual(result, { continue: true });
});

test('hook failures never block Codex', async () => {
  const result = await handleHook({ hook_event_name: 'SessionStart', source: 'startup', session_id: 'x', cwd: '/x' }, { env: { OURS_CODEX_CONTROL_SOCKET: '/bad', OURS_CODEX_CAPABILITY: 'x' }, send: async () => { throw new Error('no'); } });
  assert.deepEqual(result, { continue: true });
});

test('PostToolUse matcher accepts plugin-qualified ours tool names', () => {
  const config = JSON.parse(readFileSync(join(root, 'hooks/hooks.json'), 'utf8'));
  const matcher = new RegExp(config.hooks.PostToolUse[0].matcher);
  assert.ok(matcher.test('mcp__ours__choose_identity'));
  assert.ok(matcher.test('mcp__ours-local-testing_ours__choose_identity'));
  assert.ok(matcher.test('ours.choose_identity'));
  assert.ok(matcher.test('mcp__ours__create_temporary_identity'));
});

test('SessionEnd invokes deterministic temporary-identity cleanup', () => {
  const config = JSON.parse(readFileSync(join(root, 'hooks/hooks.json'), 'utf8'));
  assert.ok(Array.isArray(config.hooks.SessionEnd));
  const command = config.hooks.SessionEnd[0].hooks[0].command;
  assert.match(command, /^exec node .*proxy\.mjs.*session-end/);
});
