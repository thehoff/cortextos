import { logEvent } from '../bus/index.js';
import type { BusPaths } from '../types/index.js';
import { TOOL_REGISTRY, buildToolsParameter } from './tools/index.js';
import type { ToolContext } from './tools/index.js';
import type { ThreadMessage, ToolCall } from './sanitize-thread-replay.js';

/**
 * Internal LLM API surface needed by the tool loop. Boundary between the
 * loop (which only knows about Chat Completions semantics) and the runner
 * (which owns paths, heartbeats, event emission).
 */
export interface LlmCallOptions {
  endpoint: string;
  apiKey: string | undefined;
  model: string;
  maxTokens: number;
  temperature: number;
  requestTimeoutMs: number;
  /** Cache reference — once a model rejects `tools` we don't re-send it for the lifetime of the runner. */
  toolsSupported: { value: boolean };
  /**
   * Extra HTTP headers merged into every /v1/chat/completions request.
   * Spread FIRST in the fetch call, so the runner's reserved headers
   * (Content-Type, Authorization) always win at the HTTP boundary —
   * validateConfig's reserved-name guard is defense-in-depth above that.
   */
  extraHeaders?: Record<string, string>;
}

export interface ToolLoopOptions extends LlmCallOptions {
  /** Names of tools enabled on this agent. Empty → no tools sent. */
  enabledToolNames: string[];
  /**
   * Global per-tool timeout in ms. Undefined when the operator hasn't set
   * `tool_timeout_sec` in config.json — in that case the registry's per-
   * definition `defaultTimeoutMs` is used, falling back to 10s.
   */
  defaultToolTimeoutMs: number | undefined;
  /** Per-tool overrides, ms. */
  toolTimeoutsMs: Record<string, number>;
  /** Cap on tool-call iterations (assistant → tool batch → assistant counts as one). */
  maxIterations: number;
  /** Per-inbox-message bus_send_message budget. */
  sendBudget: number;
  /** Heartbeat callback fired at each loop boundary. */
  onProgress: (status: string, task: string) => void;
  /** ToolContext shared across tool dispatches in this call. */
  toolContext: Omit<ToolContext, 'sendBudget'>;
  /** Bus paths for emitting tool_call_started / tool_call_finished analytics. */
  busPaths: Readonly<BusPaths>;
  agentName: string;
  org: string;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: AssistantMessage }>;
  error?: { message?: string; type?: string };
}

interface AssistantMessage {
  role: 'assistant';
  content?: string | null;
  tool_calls?: ToolCall[];
}

const TOOLS_UNSUPPORTED_RE = /tool|function|unsupported/i;
const CONTEXT_LENGTH_RE = /context.?length|too.?long|too many tokens|maximum context/i;
const BEARER_TOKEN_RE = /Bearer\s+[A-Za-z0-9._\-+/=]+/gi;

/**
 * Strip the resolved API key + any Bearer token pattern from a piece of
 * upstream text before that text is embedded in a thrown Error message,
 * logged to stderr, or written into an analytics event.
 *
 * Some debug-style HTTP backends echo the inbound Authorization header
 * in their 4xx response body. With PR4's api_key_env, the key is a real
 * secret sourced from the org-level secrets.env — leaking it via stderr
 * would defeat the purpose of moving it out of config.json.
 *
 * The 8-character floor on the api-key substitution avoids redacting
 * accidentally-common short strings if an operator points api_key_env
 * at a placeholder value during smoke tests.
 */
export function redactSecrets(text: string, apiKey: string | undefined): string {
  let out = text;
  if (apiKey && apiKey.length >= 8) {
    out = out.split(apiKey).join('***REDACTED***');
  }
  out = out.replace(BEARER_TOKEN_RE, 'Bearer ***REDACTED***');
  return out;
}

/**
 * Single Chat Completions request with the documented fallback semantics:
 *   - On HTTP 400 whose body mentions tools/functions/unsupported, flip
 *     toolsSupported=false and re-issue without `tools`.
 *   - On HTTP 400 mentioning context-length, throw a `CONTEXT_WINDOW`
 *     error the caller can recognize and turn into a graceful failure.
 *
 * Anything else (5xx, network failure, malformed JSON) bubbles out and
 * the caller's outer try/catch handles it.
 */
async function callLlmOnce(
  messages: ThreadMessage[],
  tools: ReturnType<typeof buildToolsParameter> | null,
  opts: LlmCallOptions,
): Promise<AssistantMessage> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages,
    max_tokens: opts.maxTokens,
    temperature: opts.temperature,
  };
  if (tools && tools.length > 0 && opts.toolsSupported.value) {
    body['tools'] = tools;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.requestTimeoutMs);
  try {
    const r = await fetch(`${opts.endpoint}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        // Operator/provider headers spread first so the runner's reserved
        // headers below cannot be overridden at the HTTP boundary. The
        // validateConfig reserved-name check (§5.2 of PLAN.md) is a layer
        // of defense-in-depth above this. Both must be wrong for a
        // clobber to occur.
        ...(opts.extraHeaders ?? {}),
        'Content-Type': 'application/json',
        ...(opts.apiKey ? { 'Authorization': `Bearer ${opts.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!r.ok) {
      const rawText = (await r.text().catch(() => '')).slice(0, 500);
      if (r.status === 400 && tools && tools.length > 0 && TOOLS_UNSUPPORTED_RE.test(rawText)) {
        // Codex H3: the endpoint doesn't support `tools`. Flip the cache and
        // re-issue without tools so the agent degrades gracefully.
        opts.toolsSupported.value = false;
        return callLlmOnce(messages, null, opts);
      }
      // PR4 Codex pass-1 PR4-001 (HIGH): some upstream debug-style backends
      // echo the inbound Authorization header into 4xx bodies. Redact before
      // embedding in thrown Error message so the key cannot leak via stderr,
      // PM2 logs, or analytics events that capture the error text.
      const errText = redactSecrets(rawText, opts.apiKey);
      if (r.status === 400 && CONTEXT_LENGTH_RE.test(rawText)) {
        throw new Error('CONTEXT_WINDOW: ' + errText);
      }
      throw new Error(`LLM HTTP ${r.status}: ${errText}`);
    }
    const j = (await r.json()) as ChatCompletionResponse;
    const message = j.choices?.[0]?.message;
    if (!message) {
      throw new Error('LLM returned no choices');
    }
    return message;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Race a tool handler against a timeout. The AbortSignal fires at the
 * deadline; well-behaved async handlers stop early. Sync handlers can't
 * cancel themselves, but the loop discards their result and moves on.
 *
 * Exported so tests can pin the timeout contract without spawning the
 * full runner.
 */
export async function runToolWithTimeout(
  name: string,
  args: unknown,
  ctx: ToolContext,
  timeoutMs: number,
): Promise<string> {
  const tool = TOOL_REGISTRY[name]!;
  const controller = new AbortController();
  let resolved = false;
  const timer = setTimeout(() => {
    if (!resolved) controller.abort();
  }, timeoutMs);
  try {
    const handlerPromise = tool.handler(args, ctx, controller.signal);
    const timeoutPromise = new Promise<string>((_, reject) => {
      controller.signal.addEventListener('abort', () => {
        reject(new Error(`tool "${name}" exceeded ${timeoutMs}ms timeout`));
      });
    });
    const result = await Promise.race([handlerPromise, timeoutPromise]);
    resolved = true;
    return result;
  } finally {
    clearTimeout(timer);
  }
}

export interface ToolLoopResult {
  /** The final reply text the runner should send back via the bus. */
  finalContent: string;
  /** Messages produced during this call — assistant turns and any tool responses. The runner appends these to the thread JSONL (in order, after the user message). */
  appendMessages: ThreadMessage[];
  /** True if the loop exhausted maxIterations without producing a final answer. */
  hitMaxIterations: boolean;
}

/**
 * The tool-call loop. Drives the Chat Completions exchange until the
 * model produces a content-only response (no tool_calls) or we hit the
 * iteration cap.
 *
 * Behaviour pinned by PLAN.md and PR3 Codex passes 8 + 9:
 *   - Empty `tool_calls: []` is treated as no tools (M1).
 *   - Unknown tool name → tool response "error: unknown tool" (model can correct).
 *   - Malformed JSON args → tool response "error: malformed JSON arguments".
 *   - Per-tool timeout via AbortSignal (H1).
 *   - Heartbeat updated at each iteration + per tool dispatch (M-3).
 *   - tool_call_started/tool_call_finished analytics per dispatch (M-2).
 *   - Context-window failure → CONTEXT_WINDOW error propagated for graceful catch.
 *   - Tools-unsupported endpoint → toolsSupported flag cached, loop continues without tools.
 */
export async function callLlmWithTools(
  initialMessages: ThreadMessage[],
  opts: ToolLoopOptions,
): Promise<ToolLoopResult> {
  const messages = [...initialMessages];
  const newMessages: ThreadMessage[] = [];
  const sendBudget = { remaining: opts.sendBudget };
  const ctx: ToolContext = { ...opts.toolContext, sendBudget };
  const tools = opts.enabledToolNames.length > 0 && opts.toolsSupported.value
    ? buildToolsParameter(opts.enabledToolNames)
    : null;

  let iteration = 0;
  while (iteration < opts.maxIterations) {
    opts.onProgress('working', `thinking (iteration ${iteration + 1}/${opts.maxIterations})`);
    const wasToolsSupported = opts.toolsSupported.value;
    const assistant = await callLlmOnce(messages, tools, opts);
    // Codex P3-3: when the first call with `tools` got rejected and we
    // fell back without tools, the operator should see an analytics
    // event so the degraded mode is visible on the dashboard.
    if (wasToolsSupported && !opts.toolsSupported.value) {
      logEvent(opts.busPaths, opts.agentName, opts.org, 'action', 'tool_unsupported',
        'warning', { reason: 'endpoint_rejected_tools_parameter', model_endpoint: opts.endpoint });
    }
    messages.push(assistant);
    newMessages.push(assistant);

    const hasCalls = Array.isArray(assistant.tool_calls) && assistant.tool_calls.length > 0;
    if (!hasCalls) {
      return {
        finalContent: assistant.content?.trim() || '(empty response)',
        appendMessages: newMessages,
        hitMaxIterations: false,
      };
    }

    iteration++;

    for (const toolCall of assistant.tool_calls!) {
      const name = toolCall.function.name;
      opts.onProgress('working', `tool: ${name}`);

      const startedAt = Date.now();
      logEvent(opts.busPaths, opts.agentName, opts.org, 'action', 'tool_call_started',
        'info', { tool: name, iteration, tool_call_id: toolCall.id });

      let result: string;
      let status: 'success' | 'timeout' | 'error' | 'malformed_args' | 'unknown_tool';

      if (!(name in TOOL_REGISTRY)) {
        result = `error: unknown tool "${name}"`;
        status = 'unknown_tool';
      } else {
        let args: unknown;
        try {
          args = JSON.parse(toolCall.function.arguments || '{}');
        } catch {
          result = 'error: malformed JSON arguments';
          status = 'malformed_args';
          const tmFinish = { tool: name, iteration, status, duration_ms: Date.now() - startedAt };
          logEvent(opts.busPaths, opts.agentName, opts.org, 'action', 'tool_call_finished', 'info', tmFinish);
          messages.push({ role: 'tool', tool_call_id: toolCall.id, content: result });
          newMessages.push({ role: 'tool', tool_call_id: toolCall.id, content: result });
          continue;
        }

        // Precedence: per-tool config override > global config override
        // > per-definition default > hard fallback (10s).
        const timeoutMs =
          opts.toolTimeoutsMs[name] ??
          opts.defaultToolTimeoutMs ??
          TOOL_REGISTRY[name]!.defaultTimeoutMs ??
          10_000;
        try {
          result = await runToolWithTimeout(name, args, ctx, timeoutMs);
          status = result.startsWith('error:') ? 'error' : 'success';
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          result = `error: ${msg}`;
          status = msg.includes('timeout') ? 'timeout' : 'error';
        }
      }

      logEvent(opts.busPaths, opts.agentName, opts.org, 'action', 'tool_call_finished',
        'info', { tool: name, iteration, status, duration_ms: Date.now() - startedAt });

      const toolMessage: ThreadMessage = { role: 'tool', tool_call_id: toolCall.id, content: result };
      messages.push(toolMessage);
      newMessages.push(toolMessage);
    }
  }

  return {
    finalContent: 'I exceeded the tool-iteration budget without producing a final answer.',
    appendMessages: newMessages,
    hitMaxIterations: true,
  };
}
