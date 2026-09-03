// Fixed agent-facing adapters for remote typed commands. Remote catalogs stay
// data: they are never converted into dynamically registered MCP tools.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { JsonValue, OursClient } from '@ours.network/sdk';

import { runTool } from '../tool.js';

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.number(),
  z.string(),
  z.array(JsonValueSchema),
  z.record(JsonValueSchema),
]));

export function registerCommandTools(server: McpServer, clientFor: () => OursClient): void {
  server.tool(
    'list_contact_commands',
    'List the typed commands a contact currently advertises. The returned catalog is data; remote commands are not registered as MCP tools.',
    {
      contact: z.string().min(1).describe('Contact name or container id.'),
    },
    async ({ contact }) => runTool(
      clientFor(),
      (client) => client.listContactCommands({ contact }),
      (commands) => {
        const result = { contact, count: commands.length, commands };
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
          isError: false,
        };
      },
    ),
  );

  server.tool(
    'send_command',
    'Send a typed command to a contact after the SDK validates it against that contact\'s advertised schema. Use get_messages to retrieve a correlated command_result whose reply_to.wire_id matches request_wire_id.',
    {
      contact: z.string().min(1).describe('Contact name or container id.'),
      command: z.string().min(1).describe('Advertised command name.'),
      arguments: JsonValueSchema.describe('Any JSON-compatible command arguments accepted by the advertised schema.'),
    },
    async ({ contact, command, arguments: commandArguments }) => runTool(
      clientFor(),
      (client) => client.sendCommand({ contact, command, arguments: commandArguments }),
      (outcome) => {
        const result = { request_wire_id: outcome.wireId, outcome };
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
          isError: outcome.kind === 'refused',
        };
      },
    ),
  );
}
