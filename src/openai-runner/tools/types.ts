import type { BusPaths } from '../../types/index.js';

/**
 * A single tool the openai-compatible runner can expose to the LLM via the
 * OpenAI Chat Completions `tools` parameter.
 *
 * Each tool has:
 *   - a unique `name` (sent to the model; must match `^[a-z_][a-z0-9_]*$`),
 *   - a one-sentence `description` (sent to the model — shapes when it
 *     chooses to call the tool),
 *   - a JSON Schema for `parameters` (sent to the model — constrains the
 *     args it generates),
 *   - an async `handler` that executes the call and returns a string the
 *     model will see on the next turn.
 *
 * The handler receives an `AbortSignal` so well-behaved async tools can
 * cancel early when the runner's per-tool timeout fires. Sync-only tools
 * (filesystem reads, etc.) can't cancel themselves but the loop discards
 * their result if the timeout wins the race.
 *
 * `defaultTimeoutMs` is the per-definition fallback timeout, used when
 * neither `config.json.tool_timeouts_sec[name]` nor `tool_timeout_sec`
 * is set. The full precedence chain lives in src/cli/run-openai-agent.ts.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: object;
  defaultTimeoutMs?: number;
  handler: (args: unknown, ctx: ToolContext, signal: AbortSignal) => Promise<string>;
}

/**
 * Per-call context passed to every tool handler. Carries everything a
 * builtin tool needs without having to re-resolve from env / paths.
 *
 * `sendBudget` is mutable on purpose — bus_send_message decrements it on
 * each successful send so subsequent calls in the same tool loop see the
 * remaining count. The runner reassembles a fresh budget per inbox
 * message.
 *
 * `paths` is `Readonly<BusPaths>` because tools should never mutate the
 * shared path object — a typo in a tool implementation could otherwise
 * corrupt state for the rest of the loop.
 */
export interface ToolContext {
  agentName: string;
  agentDir: string;
  paths: Readonly<BusPaths>;
  org: string;
  /** id of the inbox message currently being processed; default reply_to for delegated sends. */
  currentInboxMsgId: string;
  /** Mutable counter — decremented when bus_send_message sends successfully. */
  sendBudget: { remaining: number };
  /** Set of agent names from enabled-agents.json — used to reject sends to non-enabled targets. */
  enabledAgentsRegistry: Set<string>;
}
