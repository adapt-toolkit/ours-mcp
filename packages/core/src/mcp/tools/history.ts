import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OursClient } from '@ours.network/sdk';

import { runTool, type McpTextResult } from '../tool.js';

const historyQuery = {
  peer_cid: z.string().min(1).optional().describe('Authenticated peer container id to filter by.'),
  direction: z.enum(['in', 'out']).optional().describe('Filter by inbound or outbound direction.'),
  before_seq: z.number().int().positive().optional().describe('Return items with seq below this pagination cursor.'),
  limit: z.number().int().min(1).max(200).optional().describe('Page size from 1 to 200 (default 50).'),
};

function pageResult<T>(page: { items: T[]; next_cursor: number | null }): McpTextResult {
  const payload = { count: page.items.length, items: page.items, next_cursor: page.next_cursor };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: false,
  };
}

function itemResult<T>(item: T | null): McpTextResult {
  const payload = { item };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: false,
  };
}

export function registerHistoryTools(server: McpServer, clientFor: () => OursClient): void {
  server.tool(
    'list_history',
    'Search persistent message history for the bound identity, newest first. Filter by ' +
      'authenticated peer container id and/or direction, and paginate with before_seq. ' +
      'Returns message bodies, read/delivery state, reply metadata, and next_cursor. Read-only.',
    historyQuery,
    async (query) => runTool(clientFor(), (c) => c.listHistory(query), pageResult),
  );

  server.tool(
    'get_history_item',
    'Look up one persistent message-history item by exact wire_id for the bound identity. ' +
      'Returns null when it is not present. Read-only.',
    { wire_id: z.string().min(1).describe('Exact message wire_id.') },
    async ({ wire_id }) => runTool(clientFor(), (c) => c.getHistoryItem({ wire_id }), itemResult),
  );

  server.tool(
    'list_files',
    'Search persistent file history for the bound identity, newest first. Filter by ' +
      'authenticated peer container id and/or direction, and paginate with before_seq. ' +
      'Returns metadata and blob provenance, never file bytes. Read-only.',
    historyQuery,
    async (query) => runTool(clientFor(), (c) => c.listFiles(query), pageResult),
  );

  server.tool(
    'get_file_info',
    'Look up one persistent file-history item by exact wire_id for the bound identity. ' +
      'Returns metadata only, or null when absent. Use save_file to stream its bytes to a chosen path.',
    { wire_id: z.string().min(1).describe('Exact file wire_id.') },
    async ({ wire_id }) => runTool(clientFor(), (c) => c.getFileInfo({ wire_id }), itemResult),
  );
}
