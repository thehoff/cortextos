import type { ToolDefinition } from './types.js';

/**
 * Returns the current time in ISO 8601 (UTC) plus the agent's configured
 * timezone if one is set on the env. The model can use this to ground its
 * answers when "now" matters (scheduling, deltas from a known date, etc.)
 * without us having to inject the time into every system prompt.
 */
export const getCurrentTimeTool: ToolDefinition = {
  name: 'get_current_time',
  description: 'Get the current UTC time in ISO 8601 format. Also returns the agent\'s configured timezone if set. Useful when the model needs to ground its answer in "now".',
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  defaultTimeoutMs: 1_000,
  handler: async () => {
    const utc = new Date().toISOString();
    const tz = process.env['CTX_TIMEZONE'] ?? 'UTC';
    return JSON.stringify({ utc, timezone: tz });
  },
};
