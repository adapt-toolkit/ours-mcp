#!/usr/bin/env node
// Measure + decode a root invite vs a child (role) invite from the running :3031 daemon.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const MCP_URL = 'http://localhost:3031/mcp';
const mcp = new Client({ name: 'measure-invite', version: '1.0.0' });
await mcp.connect(new StreamableHTTPClientTransport(new URL(MCP_URL)));
const tool = async (name, args = {}) => {
  const r = await mcp.callTool({ name, arguments: args });
  const text = (r.content || []).map((c) => c.text || '').join('\n');
  if (r.isError) throw new Error(`${name} -> ${text}`);
  return text;
};
const blobOf = (t) => t.trim().split(/\s+/).pop();
const report = (label, blob) => {
  const bytes = Buffer.from(blob, 'base64url');
  console.log(`\n${label}: ${blob.length} base64url chars = ${bytes.length} bytes`);
  // crude field scan: MUFL _write tags strings/binaries; just show the raw byte size
  // and how much is high-entropy key/sig material vs ascii (name/ids).
  let ascii = 0;
  for (const b of bytes) if (b >= 0x20 && b < 0x7f) ascii++;
  console.log(`   ~${ascii} printable bytes (names/ids/tags), ~${bytes.length - ascii} binary (keys/sigs)`);
};

await tool('choose_identity', { name: 'dev-root2' });
report('ROOT invite (dev-root2)', blobOf(await tool('generate_invite', { name: 'measure-cp' })));

const childName = `zzz-measure-${String(Date.now()).slice(-6)}`;
await tool('create_identity', { name: childName });
await tool('choose_identity', { name: childName });
report(`CHILD/role invite (${childName})`, blobOf(await tool('generate_invite', { name: 'measure-cp' })));
// cleanup the measure child via the daemon? no remove tool — leave it (dev clutter)

await mcp.close();
process.exit(0);
