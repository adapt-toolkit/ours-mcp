import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as fs from 'node:fs';

const REMOVE = [
  ['harness-cp2 (controller)', 'EC230921428D0222C3A7E3C71ABDD7BD83426678677DEA7A419EEA91CDF91C7C'],
  ['proxy2 (non-controller)',  'BE5B17A3FA391F318FD51F0488E5E40526E390FE19C6DC3D179C79716534057F'],
  ['LiveCP-wsb (my test debris)', 'DF93272AF9F9C84D6812E1541D03300A09C5DA67B8BDA781E0DB1253CE02B2F5'],
];

const mcp = new Client({ name: 'wsb-dual-reset', version: '1.0.0' });
await mcp.connect(new StreamableHTTPClientTransport(new URL('http://localhost:3031/mcp')));
const tool = async (name, args = {}) => {
  const r = await mcp.callTool({ name, arguments: args });
  const text = (r.content || []).map((c) => c.text || '').join('\n');
  return { text, isError: !!r.isError };
};

await tool('choose_identity', { name: 'dev-root2' });

for (const [label, cid] of REMOVE) {
  const r = await tool('remove_contact', { contact: cid });
  console.log(`remove ${label}: ${r.isError ? 'ERR ' : ''}${r.text.trim()}`);
}

const after = await tool('list_contacts');
console.log('=== contacts after dual reset ===\n' + after.text);

async function mint(name, path) {
  const inv = await tool('generate_invite', { name });
  if (inv.isError) throw new Error(`generate_invite(${name}) -> ${inv.text}`);
  const blob = inv.text.trim().split(/\s+/).pop();
  if (!blob || blob.length < 100) throw new Error(`no blob for ${name}: ${inv.text}`);
  fs.writeFileSync(path, blob);
  console.log(`WROTE ${name} invite len=${blob.length} -> ${path}`);
}

await mint('harness-cp', '/tmp/wse-fresh.invite');          // controller
await mint('harness-noncontroller', '/tmp/wse-fresh2.invite'); // non-controller

fs.writeFileSync('/tmp/wse-bind-code', ''); // clear any stale code
console.log('cleared /tmp/wse-bind-code');
await mcp.close();
process.exit(0);
