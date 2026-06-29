import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as fs from 'node:fs';

const CP_CID = '7025E24409FBD3594B7305ACE5CA1638FF2D5F8BB2F6C92357BBA5B6C75B03C8';
const mcp = new Client({ name: 'wsb-fresh-invite', version: '1.0.0' });
await mcp.connect(new StreamableHTTPClientTransport(new URL('http://localhost:3031/mcp')));
const tool = async (name, args = {}) => {
  const r = await mcp.callTool({ name, arguments: args });
  const text = (r.content || []).map((c) => c.text || '').join('\n');
  return { text, isError: !!r.isError };
};

await tool('choose_identity', { name: 'dev-root2' });

// Drop the stale harness-cp record so WS-E's fresh redeem is a CLEAN add on both sides
// (re-redeeming a fixed-cid proxy the root already knows can deadlock add_contact).
const rm = await tool('remove_contact', { contact: CP_CID });
console.log('=== remove_contact(harness-cp) ===\n' + rm.text);

const before = await tool('list_contacts');
console.log('=== contacts after removal ===\n' + before.text);

// Mint a fresh single-use invite that registers the redeemer as "harness-cp".
const inv = await tool('generate_invite', { name: 'harness-cp' });
if (inv.isError) { console.log('GENERATE FAILED: ' + inv.text); await mcp.close(); process.exit(2); }
const blob = inv.text.trim().split(/\s+/).pop();
if (!blob || blob.length < 100) { console.log('NO BLOB: ' + inv.text); await mcp.close(); process.exit(3); }

fs.writeFileSync('/tmp/wse-fresh.invite', blob);
console.log(`WROTE_INVITE len=${blob.length} -> /tmp/wse-fresh.invite`);
await mcp.close();
process.exit(0);
