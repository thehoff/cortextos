import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import type { ToolDefinition } from './types.js';

/**
 * Lists files in the agent's `memory/` directory. Doesn't recurse — the
 * memory directory is flat by convention (one file per day, or named
 * topic files). Returns just the filenames so the model can pick what
 * to read.
 */
export const listMemoryFilesTool: ToolDefinition = {
  name: 'list_memory_files',
  description: 'List the files in this agent\'s memory/ directory. Returns an array of filenames (no paths). Use this to discover what memory exists before calling read_memory_file.',
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  defaultTimeoutMs: 1_000,
  handler: async (_args, ctx) => {
    const memDir = join(ctx.agentDir, 'memory');
    if (!existsSync(memDir)) {
      return JSON.stringify({ files: [] });
    }
    try {
      const files = readdirSync(memDir)
        .filter(name => {
          try {
            return statSync(join(memDir, name)).isFile();
          } catch {
            return false;
          }
        });
      return JSON.stringify({ files });
    } catch (err) {
      return `error: failed to list memory directory: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
