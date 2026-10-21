import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

for (const plugin of ['codex', 'claude-code']) test(`${plugin} discovers local tools without a remote MCP endpoint`, { timeout: 10000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'ours-local-tools-'));
  const config = join(home, 'profile.json');
  writeFileSync(join(home, 'token'), 'test-only', { mode: 0o600 });
  writeFileSync(config, JSON.stringify({ serverUrl: 'http://127.0.0.1:1', endpoint: 'http://127.0.0.1:1/daemon', expectedInstanceId: '12345678-1234-1234-1234-123456789abc', credentialPath: join(home, 'token') }), { mode: 0o600 });
  const transport = new StdioClientTransport({ command: process.execPath, args: [process.env.OURS_TEST_PLUGIN_ROOT ? join(process.env.OURS_TEST_PLUGIN_ROOT, plugin, 'bin/proxy.mjs') : fileURLToPath(new URL(`../../${plugin}/bin/proxy.mjs`, import.meta.url))], env: { PATH: process.env.PATH, HOME: home, OURS_CONFIG: config, OURS_MCP_CONFIG: join(home, 'identities.json'), CLAUDE_CODE_SESSION_ID: 'test-chat' }, stderr: 'pipe' });
  const client = new Client({ name: 'local-tools-test', version: '1' });
  try {
    await client.connect(transport, { timeout: 3000 });
    const result = await client.listTools();
    for (const name of ['send_message', 'send_file', 'save_file', 'create_temporary_identity']) assert.ok(result.tools.some(t => t.name === name), name);
  } finally { await client.close(); await transport.close(); rmSync(home, { recursive: true, force: true }); }
});
