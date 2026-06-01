import { sendMessage } from '../../bus/index.js';
import type { Priority } from '../../types/index.js';
import type { ToolDefinition } from './types.js';

const SAFE_ID_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/;
const VALID_PRIORITIES = new Set<Priority>(['urgent', 'high', 'normal', 'low']);

/**
 * Delegates a task to another agent on the bus. The model picks the target
 * agent by name; the runner validates the target is enabled before sending
 * (Codex M3 — prevents silent dead letters to nonexistent agents).
 *
 * Per-inbox-message send budget (default 3) caps the maximum delegation
 * fanout from one model turn. `reply_to` defaults to the current inbox
 * message id so the recipient can thread its response back to the user's
 * original prompt.
 *
 * NOTE: this only bounds delegation WITHIN a single inbox message. Two
 * tool-enabled agents that mutually delegate could ping-pong across
 * inbox messages — see `bus_send_message` risk register in
 * `cortextos-workspace/work/feat-thin-tools/PLAN.md`.
 */
export const busSendMessageTool: ToolDefinition = {
  name: 'bus_send_message',
  description: 'Send a message to another enabled agent on the bus. Use this to delegate a sub-task or ask another specialist for information. The target must be enabled; non-enabled targets are rejected.',
  parameters: {
    type: 'object',
    properties: {
      to: {
        type: 'string',
        description: 'Target agent name. Must be enabled in this instance.',
      },
      text: {
        type: 'string',
        description: 'Message body to send.',
      },
      priority: {
        type: 'string',
        enum: ['urgent', 'high', 'normal', 'low'],
        description: 'Message priority. Defaults to "normal".',
      },
      reply_to: {
        type: 'string',
        description: 'Optional. Defaults to the current inbox message id so the recipient threads its reply correctly.',
      },
    },
    required: ['to', 'text'],
    additionalProperties: false,
  },
  defaultTimeoutMs: 2_000,
  handler: async (args, ctx) => {
    const argsObj = args as { to?: unknown; text?: unknown; priority?: unknown; reply_to?: unknown } | null;
    if (!argsObj || typeof argsObj.to !== 'string' || !argsObj.to) {
      return 'error: missing or non-string argument "to"';
    }
    if (typeof argsObj.text !== 'string' || !argsObj.text.trim()) {
      return 'error: missing or empty argument "text"';
    }
    if (ctx.sendBudget.remaining <= 0) {
      return `error: bus_send_message budget exhausted for this inbox message (cap reached)`;
    }
    if (!ctx.enabledAgentsRegistry.has(argsObj.to)) {
      return `error: agent "${argsObj.to}" is not enabled in this instance; cannot deliver`;
    }

    const priority: Priority = (typeof argsObj.priority === 'string' &&
      VALID_PRIORITIES.has(argsObj.priority as Priority))
      ? argsObj.priority as Priority
      : 'normal';

    let replyTo = ctx.currentInboxMsgId;
    if (typeof argsObj.reply_to === 'string' && argsObj.reply_to) {
      if (!SAFE_ID_RE.test(argsObj.reply_to)) {
        return 'error: reply_to has invalid id format';
      }
      replyTo = argsObj.reply_to;
    }

    try {
      const newMsgId = sendMessage(ctx.paths, ctx.agentName, argsObj.to, priority, argsObj.text, replyTo);
      ctx.sendBudget.remaining--;
      return JSON.stringify({ ok: true, msg_id: newMsgId, remaining_budget: ctx.sendBudget.remaining });
    } catch (err) {
      return `error: send failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
