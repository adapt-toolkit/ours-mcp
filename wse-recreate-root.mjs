import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as fs from 'node:fs';

const EXPECT_CID = 'EE73A347AC34C53F16431243D37827FB948A49E861E1065CC3AEC29872B41748';
const mcp = new Client({ name: 'wsb-recreate', version: '1.0.0' });
await mcp.connect(new StreamableHTTPClientTransport(new URL('http://localhost:3031/mcp')));
const tool = async (name, args = {}) => {
  const r = await mcp.callTool({ name, arguments: args });
  const text = (r.content || []).map((c) => c.text || '').join('\n');
  if (r.isError) throw new Error(`MCP ${name} -> ${text}`);
  return text;
};

const created = await tool('create_root_identity', { name: 'dev-root2' });
console.log('=== create_root_identity ===\n' + created);
const cid = (created.match(/[0-9A-F]{64}/) || [(await tool('current_identity')).match(/[0-9A-F]{64}/)?.[0]])[0];
console.log(`root cid: ${cid}`);
console.log(`cid matches prior deterministic EE73A347…: ${cid === EXPECT_CID}`);

await tool('choose_identity', { name: 'dev-root2' });
console.log('=== contacts ===\n' + (await tool('list_contacts')).text);
console.log('=== identities ===\n' + (await tool('list_identities')).text);
console.log('=== status ===\n' + (await tool('get_monitoring_status')).text);

async function mint(name, path) {
  const inv = await tool('generate_invite', { name });
  const blob = inv.trim().split(/\s+/).pop();
  if (!blob || blob.length < 100) throw new Error(`no blob for ${name}`);
  fs.writeFileSync(path, blob);
  console.log(`WROTE ${name} -> ${path} (len=${blob.length})`);
}
await mint('harness-cp', '/tmp/wse-fresh.invite');
await mint('harness-noncontroller', '/tmp/wse-fresh2.invite');
fs.writeFileSync('/tmp/wse-bind-code', '');
console.log('cleared /tmp/wse-bind-code');
await mcp.close();
process.exit(0);
