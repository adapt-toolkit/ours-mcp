import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolRequestExtra } from './tool.js';

export const REGISTRY_VERSION = 1 as const;
export const TOOL_EFFECTS = ['bound', 'binding', 'lifecycle', 'profile', 'contact', 'inventory', 'filesystem', 'workspace-pin'] as const;
export type ToolEffect = typeof TOOL_EFFECTS[number];
export interface ToolPolicy {
  version: typeof REGISTRY_VERSION;
  allowedEffects: readonly ToolEffect[];
  /** Admission spans the entire handler, including file callbacks and rendering. */
  admit: (tool: string, extra: ToolRequestExtra) => Promise<() => void | Promise<void>>;
}

/** Registrations own their effects alongside their original schemas and handlers. */
export class ToolRegistry {
  readonly entries: Array<{ name: string; effect: ToolEffect }> = [];
  constructor(private readonly server: McpServer, private readonly policy?: ToolPolicy) {
    if (policy && (policy.version !== REGISTRY_VERSION || policy.allowedEffects.some(e => !TOOL_EFFECTS.includes(e)))) {
      throw new Error('Unsupported ours MCP registry policy');
    }
  }
  tool(effect: ToolEffect): McpServer['tool'] {
    if (!TOOL_EFFECTS.includes(effect)) throw new Error('Unclassified ours MCP tool effect');
    // Preserve the MCP SDK's overloads and inference at every registration site.
    return ((...args: unknown[]) => {
      const name = args[0] as string;
      if (this.entries.some(e => e.name === name)) throw new Error(`Duplicate tool: ${name}`);
      this.entries.push({ name, effect });
      if (this.policy && !this.policy.allowedEffects.includes(effect)) return;
      const handler = args.pop() as (...args: unknown[]) => unknown;
      args.push(async (...callArgs: unknown[]) => {
        if (this.policy && !this.policy.allowedEffects.includes(effect)) throw new Error('Forbidden tool effect');
        const release = await this.policy?.admit(name, callArgs.at(-1) as ToolRequestExtra);
        try { return await handler(...callArgs); }
        finally { await release?.(); }
      });
      return (this.server.tool as (...args: unknown[]) => unknown)(...args);
    }) as McpServer['tool'];
  }
}
