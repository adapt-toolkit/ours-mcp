import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createOursMcpServer } from '@ours.network/mcp/server';

async function connect(sdk) {
  const server = createOursMcpServer(sdk, 'test', { list: async () => [] });
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

// Some consumers reject recursive ($ref-cycle) function parameters for every
// request, e.g. https://dev.meta.ai/docs/structured-output. Follow each local
// $ref and fail on a reference that re-enters a schema already on the path.
function refCycles(root) {
  const cycles = [];
  const resolve = ref => ref.slice(2).split('/').filter(Boolean).reduce((n, k) => n?.[k.replace(/~1/g, '/').replace(/~0/g, '~')], root);
  const walk = (node, path, stack) => {
    if (!node || typeof node !== 'object') return;
    if (stack.includes(node)) { cycles.push(path); return; }
    const next = [...stack, node];
    if (typeof node.$ref === 'string') walk(resolve(node.$ref), `${path} -> ${node.$ref}`, next);
    for (const [k, v] of Object.entries(node)) if (k !== '$ref') walk(v, `${path}/${k}`, next);
  };
  walk(root, '#', []);
  return cycles;
}

test('every advertised tool schema is free of $ref cycles', async () => {
  const c = await connect(new Proxy({}, { get: () => async () => { throw Error('must not dispatch'); } }));
  try {
    for (const tool of (await c.client.listTools()).tools) {
      assert.deepEqual(refCycles(tool.inputSchema), [], `${tool.name} input`);
      if (tool.outputSchema) assert.deepEqual(refCycles(tool.outputSchema), [], `${tool.name} output`);
    }
    const args = (await c.client.listTools()).tools.find(t => t.name === 'send_command').inputSchema.properties.arguments;
    assert.deepEqual(args.anyOf.map(s => s.type), ['null', 'boolean', 'number', 'string', 'array', 'object']);
  } finally { await c.close(); }
});

test('send_command forwards any JSON value and keeps nested runtime validation', async () => {
  const sent = [];
  const c = await connect({ currentIdentity: async () => ({ name: 'Agent', cid: 'A', described: true }), sendCommand: async req => { sent.push(req.arguments); return { kind: 'e2e', wireId: 'W' }; } });
  try {
    const values = [null, true, 42, 'text', [], [1, ['two', { three: [null] }]], {}, { a: { b: [{ c: false }] } }];
    for (const value of values) {
      const r = await c.client.callTool({ name: 'send_command', arguments: { contact: 'Peer', command: 'run', arguments: value } });
      assert.equal(r.isError, false, JSON.stringify([value, r.content]));
    }
    assert.deepEqual(sent, values);
    // In-memory transport passes objects unserialized, so non-JSON values reach validation.
    for (const value of [undefined, { a: { b: undefined } }, [1, [() => 0]]]) {
      const r = await c.client.callTool({ name: 'send_command', arguments: { contact: 'Peer', command: 'run', arguments: value } });
      assert.equal(r.isError, true);
    }
    assert.equal(sent.length, values.length);
  } finally { await c.close(); }
});
