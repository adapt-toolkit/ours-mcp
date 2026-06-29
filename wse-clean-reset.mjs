import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as fs from 'node:fs';

const mcp = new Client({ name: 'wsb-clean-reset', version: '1.0.0' });
await mcp.connect(new StreamableHTTPClientTransport(new URL('http://localhost:3031/mcp')));
const tool = async (name, args = {}) => {
  const r = await mcp.callTool({ name, arguments: args });
  const text = (r.content || []).map((c) => c.text || '').join('\n');
  return { text, isError: !!r.isError };
};

await tool('choose_identity', { name: 'dev-root2' });

// --- remove every role identity under dev-root2 (lines: "└ <name> — <cid> (role)") ---
const ids = (await tool('list_identities')).text;
console.log('=== identities BEFORE ===\n' + ids);
const roleNames = [...ids.matchAll(/└\s*(\S+)\s+—\s+[0-9A-F]{64}\s+\(role\)/g)].map((m) => m[1]);
for (const n of roleNames) {
  const r = await tool('remove_identity', { name: n });
  console.log(`remove_identity ${n}: ${r.isError ? 'ERR ' : ''}${r.text.trim()}`);
}

// --- remove every contact (by cid, unambiguous) ---
const contacts = (await tool('list_contacts')).text;
const cids = [...contacts.matchAll(/•\s*\S.*?—\s+([0-9A-F]{64})/g)].map((m) => m[1]);
for (const cid of cids) {
  const r = await tool('remove_contact', { contact: cid });
  console.log(`remove_contact ${cid.slice(0, 12)}…: ${r.isError ? 'ERR ' : ''}${r.text.trim()}`);
}

const after = await tool('list_contacts');
const afterIds = await tool('list_identities');
console.log('=== contacts AFTER ===\n' + after.text);
console.log('=== identities AFTER ===\n' + afterIds.text);
console.log('=== status AFTER ===\n' + (await tool('get_monitoring_status')).text);

async function mint(name, path) {
  const inv = await tool('generate_invite', { name });
  if (inv.isError) throw new Error(`generate_invite(${name}) -> ${inv.text}`);
  const blob = inv.text.trim().split(/\s+/).pop();
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
