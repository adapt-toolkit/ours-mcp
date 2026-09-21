import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('host hooks filter API metadata through local identities without remote MCP', async () => {
  const { readHostHookState } = await import('../dist/host-hooks.mjs');
  const root = mkdtempSync(join(tmpdir(), 'ours-hook-api-'));
  const id = '12345678-1234-1234-1234-123456789abc';
  const applicationPath = join(root, 'custom.json');
  writeFileSync(applicationPath, JSON.stringify({ version: 1, daemons: {}, instances: { [id]: { identities: ['Visible'] } } }));
  let closed = 0;
  try {
    const state = await readHostHookState({ profile: { expectedInstanceId: id }, nativeSessionId: 'chat', applicationPath, clientFor: async () => ({
      unread: async () => ({ identities: [{ name: 'Visible', count: 1, recent: [{ from: 'sender', text: 'secret' }] }, { name: 'Hidden', count: 1 }] }),
      listIdentities: async () => [{ name: 'Visible', session: 'mine' }, { name: 'Hidden', session: 'other-live' }],
      close: async () => { closed++; },
    }) });
    assert.deepEqual(state.identities, ['Visible']);
    assert.deepEqual(state.bindings, ['Visible']);
    assert.equal(state.unread.identities.length, 1);
    assert.ok(!JSON.stringify(state).includes('secret'));
    assert.equal(closed, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
