import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as fs from 'node:fs';

const CP_CID = '7025E24409FBD3594B7305ACE5CA1638FF2D5F8BB2F6C92357BBA5B6C75B03C8';
const mcp = new Client({ name: 'wsb-wse-bind', version: '1.0.0' });
await mcp.connect(new StreamableHTTPClientTransport(new URL('http://localhost:3031/mcp')));
const tool = async (name, args = {}) => {
  const r = await mcp.callTool({ name, arguments: args });
  const text = (r.content || []).map((c) => c.text || '').join('\n');
  if (r.isError) throw new Error(`MCP ${name} -> ${text}`);
  return text;
};

await tool('choose_identity', { name: 'dev-root2' });
const contacts = await tool('list_contacts');
console.log('=== contacts ===\n' + contacts);
const hasCp = contacts.includes(CP_CID);
console.log(`harness-cp present as contact: ${hasCp}`);
if (!hasCp) {
  console.log('ABORT: harness-cp is not a contact of dev-root2 — WS-E must complete the invite handshake first.');
  await mcp.close();
  process.exit(2);
}

const bindText = await tool('bind_monitoring_proxy', { contact: CP_CID });
console.log('=== bind_monitoring_proxy ===\n' + bindText);
const code = (bindText.match(/Verification code:\s*(\d{6})/) || [])[1];
if (!code) { console.log('ABORT: no 6-digit code parsed'); await mcp.close(); process.exit(3); }

const status = await tool('get_monitoring_status');
console.log('=== get_monitoring_status (core cell) ===\n' + status);
const pending = /proxy code verification is pending/.test(status);
console.log(`core-cell pending confirmed: ${pending}`);
if (!pending) { console.log('ABORT: pending not confirmed on the core cell'); await mcp.close(); process.exit(4); }

fs.writeFileSync('/tmp/wse-bind-code', code);
console.log(`WROTE_CODE=${code} -> /tmp/wse-bind-code`);
await mcp.close();
process.exit(0);
