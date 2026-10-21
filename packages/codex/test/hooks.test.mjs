import test from 'node:test';
import assert from 'node:assert/strict';
import { handleHook } from '../dist/hooks-runner.mjs';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test('SessionStart registers the thread and injects body-free unread context', async () => {
  const commands = [];
  const home = mkdtempSync(join(tmpdir(), 'ours-codex-hook-'));
  const stateDir = join(home, 'state');
  const appConfig = join(home, 'ours-mcp.json');
  writeFileSync(appConfig, JSON.stringify({ version: 1, daemons: { [stateDir]: { identities: ['Alice'] } } }));
  writeFileSync(join(home, 'profile.json'), JSON.stringify({ serverUrl: 'http://gateway.test', expectedInstanceId: '11111111-2222-3333-4444-555555555555', credentialPath: join(home,'credential') }), { mode:0o600 });
  const result = await handleHook({ hook_event_name: 'SessionStart', source: 'startup', session_id: 'thr', cwd: '/repo' }, {
    env: { HOME: home, OURS_CONFIG: join(home, 'profile.json'), OURS_CODEX_CONTROL_SOCKET: '/tmp/s', OURS_CODEX_CAPABILITY: 'cap', OURS_MCP_CONFIG: appConfig },
    send: async (...args) => { commands.push(args); return { state: {} }; },
    readHostState: async () => ({ unread: { identities: [{ name: 'Alice', count: 2, files: 0 }] } }),
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

test('shipped hooks invoke the package-local bundled runner', () => {
  const config = JSON.parse(readFileSync(join(root, 'hooks/hooks.json'), 'utf8'));
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PostToolUse']) {
    assert.match(config.hooks[event][0].hooks[0].command, /dist\/hooks-runner\.mjs/);
  }
});

test('SessionEnd invokes deterministic temporary-identity cleanup', () => {
  const config = JSON.parse(readFileSync(join(root, 'hooks/hooks.json'), 'utf8'));
  assert.ok(Array.isArray(config.hooks.SessionEnd));
  const command = config.hooks.SessionEnd[0].hooks[0].command;
  assert.match(command, /^exec node .*proxy\.mjs.*session-end/);
});

for (const managed of [false, true]) test(`${managed ? 'managed' : 'explicit'} profile filters SDK unread through the local application registry`, async () => {
  const home = mkdtempSync(join(tmpdir(), 'ours-codex-profile-hook-'));
  const appConfig = join(home, 'ours-mcp.json');
  if (managed) mkdirSync(join(home, '.ours-client'), { mode: 0o700 });
  const profilePath = managed ? join(home, '.ours-client', 'profile.json') : join(home, 'profile.json');
  const instanceId = '12345678-1234-1234-1234-123456789abc';
  writeFileSync(appConfig, JSON.stringify({ version: 1, daemons: {}, instances: { [instanceId]: { identities: ['Mallory'] } } }));
  writeFileSync(profilePath, JSON.stringify({ serverUrl: 'http://127.0.0.1:4050', endpoint: 'http://127.0.0.1:4050/daemon', expectedInstanceId: instanceId, credentialPath: join(home, 'token') }), { mode: 0o600 });
  const calls = [];
  const result = await handleHook({ hook_event_name: 'UserPromptSubmit', session_id: 'thread-a', cwd: '/repo' }, {
    env: { HOME: home, ...(managed ? {} : { OURS_CONFIG: profilePath }), OURS_MCP_CONFIG: appConfig },
    readHostState: async ({ nativeSessionId, applicationPath }) => {
      calls.push([nativeSessionId, applicationPath]);
      return { unread: { identities: [{ name: 'Alice', count: 2, files: 0 }] } };
    },
    fetch: async () => assert.fail('explicit profile must not fetch unread directly'), findPin: async () => null,
  });
  assert.match(result.hookSpecificOutput.additionalContext, /Alice.*2 unread/s);
  assert.doesNotMatch(result.hookSpecificOutput.additionalContext, /Mallory/);
  assert.deepEqual(calls, [['thread-a', appConfig]]);
});

test('explicit profile resolution failure never falls back to legacy unread', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ours-codex-profile-failure-'));
  const profilePath = join(home, 'profile.json');
  writeFileSync(profilePath, JSON.stringify({ serverUrl: 'http://127.0.0.1:4050', endpoint: 'http://127.0.0.1:4050/daemon', expectedInstanceId: '12345678-1234-1234-1234-123456789abc', credentialPath: join(home, 'token') }), { mode: 0o600 });
  let fetched = false;
  const result = await handleHook({ hook_event_name: 'UserPromptSubmit', cwd: '/repo' }, {
    env: { HOME: home, OURS_CONFIG: profilePath },
    profileResolver: async () => { throw new Error('daemon instance mismatch'); },
    fetch: async () => { fetched = true; return Response.json({ identities: [] }); },
    findPin: async () => null,
  });
  assert.deepEqual(result, { continue: true });
  assert.equal(fetched, false);
});

test('network profile never invokes the obsolete Docker application-identity route', async () => {
  const { chmodSync, existsSync, rmSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'ours-hooks-container-'));
  try {
    const profile = join(dir, 'profile.json');
    const marker = join(dir, 'docker-called');
    writeFileSync(profile, JSON.stringify({ serverUrl: 'http://localhost:3050', endpoint: 'http://localhost:3050/daemon', expectedInstanceId: '12345678-1234-1234-1234-123456789abc', credentialPath: '/token', composeFile: '/compose.yml' }), { mode: 0o600 });
    const appConfig = join(dir, 'host.json');
    writeFileSync(appConfig, JSON.stringify({ version: 1, daemons: {}, instances: { '12345678-1234-1234-1234-123456789abc': { identities: ['HostOnly'] } } }));
    writeFileSync(join(dir, 'docker'), `#!${process.execPath}\nimport fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'called'); process.exit(41);`);
    chmodSync(join(dir, 'docker'), 0o755);
    const env = { PATH: dir, OURS_CONFIG: profile, OURS_MCP_CONFIG: appConfig };
    const deps = {
      env,
      findPin: async () => null,
      readHostState: async () => ({ unread: { identities: [{ name: 'HostOnly', count: 8 }] } }),
    };
    const payload = { hook_event_name: 'SessionStart', session_id: 'thread-a' };
    const result = await handleHook(payload, deps);
    assert.match(result.hookSpecificOutput.additionalContext, /HostOnly: 8/);
    assert.doesNotMatch(result.hookSpecificOutput.additionalContext, /NetworkOnly/);
    assert.equal(existsSync(marker), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
