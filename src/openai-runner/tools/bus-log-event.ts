import { logEvent } from '../../bus/index.js';
import type { ToolDefinition } from './types.js';

// Per-message cap on `bus_log_event` calls — prevents a runaway model from
// flooding the analytics stream with hundreds of events per turn.
const MAX_EVENTS_PER_MESSAGE = 10;

// Track count per ToolContext instance via a WeakMap so we don't need to add
// a field on every ToolContext. ToolContext is constructed fresh per inbox
// message in the runner, so each message gets its own count.
const eventCounts = new WeakMap<object, number>();

/**
 * Lets the model emit a single analytics event from inside a tool turn.
 * The event category is fixed to `action` so the model can't pollute the
 * schema (only the `event` name, `severity`, and `meta` JSON are
 * model-controlled).
 */
export const busLogEventTool: ToolDefinition = {
  name: 'bus_log_event',
  description: 'Record an analytics event in the agent\'s event log. Use this to note things the operator might want to see in the dashboard (e.g. a sub-task started, an unusual condition observed). Category is always "action".',
  parameters: {
    type: 'object',
    properties: {
      event: {
        type: 'string',
        description: 'Short event name (e.g. "kb_lookup", "delegation_started"). Required.',
      },
      severity: {
        type: 'string',
        enum: ['info', 'warning', 'error'],
        description: 'Event severity. Defaults to "info".',
      },
      meta: {
        type: 'object',
        description: 'Optional metadata object. Keep it small.',
      },
    },
    required: ['event'],
    additionalProperties: false,
  },
  defaultTimeoutMs: 1_000,
  handler: async (args, ctx) => {
    const argsObj = args as { event?: unknown; severity?: unknown; meta?: unknown } | null;
    if (!argsObj || typeof argsObj.event !== 'string' || !argsObj.event.trim()) {
      return 'error: missing or non-string argument "event"';
    }
    const seen = (eventCounts.get(ctx) ?? 0);
    if (seen >= MAX_EVENTS_PER_MESSAGE) {
      return `error: bus_log_event budget exhausted for this inbox message (cap ${MAX_EVENTS_PER_MESSAGE})`;
    }
    const severity = (typeof argsObj.severity === 'string' &&
      ['info', 'warning', 'error'].includes(argsObj.severity))
      ? argsObj.severity as 'info' | 'warning' | 'error'
      : 'info';
    const meta = (argsObj.meta && typeof argsObj.meta === 'object')
      ? argsObj.meta as Record<string, unknown>
      : {};
    try {
      logEvent(ctx.paths, ctx.agentName, ctx.org, 'action', argsObj.event, severity, meta);
      eventCounts.set(ctx, seen + 1);
      return 'ok';
    } catch (err) {
      return `error: failed to write event: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
