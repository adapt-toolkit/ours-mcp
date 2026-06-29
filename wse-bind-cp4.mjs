import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as fs from 'node:fs';

const CP_CID = '01FFD182B2811191A5D413BBF2C9A406AFFD263A6955A8FD77B1C6AF77140057';
const mcp = new Client({ name: 'wsb-bind-cp4', version: '1.0.0' });
await mcp.connect(new StreamableHTTPClientTransport(new URL('http://localhost:3031/mcp')));
const tool = async (name, args = {}) => {
  const r = await mcp.callTool({ name, arguments: args });
  const text = (r.content || []).map((c) => c.text || '').join('\n');
  if (r.isError) throw new Error(`MCP ${name} -> ${text}`);
  return text;
};

await tool('choose_identity', { name: 'dev-root2' });
const contacts = await tool('list_contacts');
if (!contacts.includes(CP_CID)) { console.log('ABORT: harness-cp4 not a contact yet:\n' + contacts); await mcp.close(); process.exit(2); }

const bindText = await tool('bind_monitoring_proxy', { contact: CP_CID });
console.log('=== bind_monitoring_proxy ===\n' + bindText);
const code = (bindText.match(/Verification code:\s*(\d{6})/) || [])[1];
if (!code) { console.log('ABORT: no code'); await mcp.close(); process.exit(3); }

const status = await tool('get_monitoring_status');
console.log('=== get_monitoring_status (core cell) ===\n' + status);
if (!/proxy code verification is pending/.test(status)) { console.log('ABORT: pending not confirmed'); await mcp.close(); process.exit(4); }

fs.writeFileSync('/tmp/wse-bind-code', code);
console.log(`WROTE_CODE=${code} for harness-cp4 ${CP_CID} -> /tmp/wse-bind-code`);
await mcp.close();
process.exit(0);
