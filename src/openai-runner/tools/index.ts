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

/**
 * Build the `tools` array for the Chat Completions request. The runner
 * passes the list of tool NAMES that the agent's config.json enabled;
 * we look up each in the registry and emit the OpenAI-spec shape.
 *
 * Caller validates names against the registry before this is reached
 * (boot-time check — see config validation in run-openai-agent.ts).
 */
export function buildToolsParameter(
  enabledNames: string[],
): Array<{ type: 'function'; function: { name: string; description: string; parameters: object } }> {
  return enabledNames.map(name => {
    const tool = TOOL_REGISTRY[name]!;
    return {
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    };
  });
}
