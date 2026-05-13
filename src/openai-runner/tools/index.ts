import type { ToolDefinition } from './types.js';
import { getCurrentTimeTool } from './get-current-time.js';
import { listMemoryFilesTool } from './list-memory-files.js';
import { readMemoryFileTool } from './read-memory-file.js';
import { kbSearchTool } from './kb-search.js';
import { busLogEventTool } from './bus-log-event.js';
import { busSendMessageTool } from './bus-send-message.js';

export type { ToolDefinition, ToolContext } from './types.js';

/**
 * Single source of truth for the runner's tool surface. Order doesn't
 * matter; tools are looked up by name. Adding a tool means:
 *   1. Define it in its own file with the ToolDefinition shape.
 *   2. Import + add it here.
 *   3. Document it in cortextos-workspace/work/feat-thin-tools/PLAN.md.
 */
export const TOOL_REGISTRY: Record<string, ToolDefinition> = {
  [getCurrentTimeTool.name]: getCurrentTimeTool,
  [listMemoryFilesTool.name]: listMemoryFilesTool,
  [readMemoryFileTool.name]: readMemoryFileTool,
  [kbSearchTool.name]: kbSearchTool,
  [busLogEventTool.name]: busLogEventTool,
  [busSendMessageTool.name]: busSendMessageTool,
};

/** MCP-discovered tool descriptor as exposed by the manager. */
export interface McpToolForRegistry {
  name: string;                  // qualified, e.g. mcp__sqlite__query
  description?: string;
  inputSchema?: unknown;
}

/**
 * Build the `tools` array for the Chat Completions request. Looks up
 * each enabled name in the builtin registry OR in the optional MCP
 * tools list (PR5). Unknown names are silently skipped — the caller
 * validates name existence via the phased check at boot, so reaching
 * this with an unknown name is a programmer error rather than
 * something the LLM ought to see.
 */
export function buildToolsParameter(
  enabledNames: string[],
  mcpTools?: ReadonlyArray<McpToolForRegistry>,
): Array<{ type: 'function'; function: { name: string; description: string; parameters: object } }> {
  const mcpByName = new Map<string, McpToolForRegistry>();
  for (const t of mcpTools ?? []) mcpByName.set(t.name, t);

  const out: Array<{ type: 'function'; function: { name: string; description: string; parameters: object } }> = [];
  for (const name of enabledNames) {
    if (name in TOOL_REGISTRY) {
      const tool = TOOL_REGISTRY[name]!;
      out.push({
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      });
    } else if (mcpByName.has(name)) {
      const mcp = mcpByName.get(name)!;
      out.push({
        type: 'function' as const,
        function: {
          name: mcp.name,
          description: mcp.description ?? '',
          parameters: (mcp.inputSchema as object) ?? { type: 'object', properties: {} },
        },
      });
    }
    // Unknown names: skipped. Validation happens elsewhere.
  }
  return out;
}
