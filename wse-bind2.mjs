import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as fs from 'node:fs';

const mcp = new Client({ name: 'wsb-wse-bind2', version: '1.0.0' });
await mcp.connect(new StreamableHTTPClientTransport(new URL('http://localhost:3031/mcp')));
const tool = async (name, args = {}) => {
  const r = await mcp.callTool({ name, arguments: args });
  const text = (r.content || []).map((c) => c.text || '').join('\n');
  if (r.isError) throw new Error(`MCP ${name} -> ${text}`);
  return text;
};

await tool('choose_identity', { name: 'dev-root2' });
// bind by NAME so it resolves to harness-cp's CURRENT cid (the fresh redeem), not a stale one
const bindText = await tool('bind_monitoring_proxy', { contact: 'harness-cp' });
console.log('=== bind_monitoring_proxy(harness-cp) ===\n' + bindText);
const code = (bindText.match(/Verification code:\s*(\d{6})/) || [])[1];
const cid = (bindText.match(/\(([0-9A-F]{64})\)/) || [])[1];
if (!code) { console.log('ABORT: no code'); await mcp.close(); process.exit(3); }

const status = await tool('get_monitoring_status');
console.log('=== get_monitoring_status (core cell) ===\n' + status);
if (!/proxy code verification is pending/.test(status)) { console.log('ABORT: pending not confirmed'); await mcp.close(); process.exit(4); }

fs.writeFileSync('/tmp/wse-bind-code', code);
console.log(`WROTE_CODE=${code} for harness-cp cid ${cid} -> /tmp/wse-bind-code`);
await mcp.close();
process.exit(0);
