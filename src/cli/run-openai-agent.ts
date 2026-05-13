import { Command } from 'commander';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import * as readline from 'readline';
import { sendMessage, ackInbox, updateHeartbeat, logEvent } from '../bus/index.js';
import { resolvePaths } from '../utils/paths.js';
import { stripControlChars } from '../utils/validate.js';
import { callLlmWithTools } from '../openai-runner/loop.js';
import { sanitizeForLlmReplay, type ThreadMessage } from '../openai-runner/sanitize-thread-replay.js';
import { TOOL_REGISTRY } from '../openai-runner/tools/index.js';

export interface RunnerConfig {
  endpoint: string;
  model: string;
  api_key?: string;
  /** Name of a process.env variable holding the API key. Mutually exclusive with api_key. */
  api_key_env?: string;
  /** Extra HTTP headers merged into every /v1/chat/completions request. Cannot override Content-Type or Authorization. */
  headers?: Record<string, string>;
  /** Informational provider tag. Some values (e.g. "openrouter") trigger default headers. */
  provider?: string;
  max_tokens?: number;
  temperature?: number;
  heartbeat_interval_sec?: number;
  request_timeout_sec?: number;
  /** Names of tools (from TOOL_REGISTRY) the model can call. Empty/absent = no tools. */
  tools?: string[];
  /** Max number of tool-call iterations per inbox message. Default 5. */
  tool_loop_max_iterations?: number;
  /** Global per-tool timeout in seconds. Default 10. */
  tool_timeout_sec?: number;
  /** Per-tool timeout overrides in seconds. */
  tool_timeouts_sec?: Record<string, number>;
  /** Cap on bus_send_message calls per inbox message. Default 3. */
  tool_bus_send_budget?: number;
}

const ENV_VAR_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const HTTP_HEADER_NAME_RE = /^[A-Za-z][A-Za-z0-9-]*$/;
const PROVIDER_TAG_RE = /^[a-z][a-z0-9-]*$/;
const RESERVED_HEADER_NAMES_LOWER = new Set(['content-type', 'authorization']);

interface ParsedMessage {
  sender: string;
  msgId: string;
  body: string;
}

/**
 * FastChecker AGENT MESSAGE envelope format
 * (mirror of src/daemon/fast-checker.ts:222 — keep in sync).
 *
 *   === AGENT MESSAGE from <sender>[ [reply_to: <id>]] [msg_id: <id>] ===
 *   ```
 *   <body — may contain inner ``` fences, "Reply using:" lines, anything>
 *   ```
 *   Reply using: cortextos bus send-message <sender> normal '<your reply>' <msg_id>
 */
const HEADER_RE = /^=== AGENT MESSAGE from ([a-zA-Z0-9_-]+)(?: \[reply_to: ([a-zA-Z0-9_.-]+)\])? \[msg_id: ([a-zA-Z0-9_.-]+)\] ===$/;
const TERMINATOR_RE = /^Reply using: cortextos bus send-message \S+ normal '<your reply>' \S+\s*$/;
const SAFE_ID_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/;

const MEMORY_HEADER_RE = /^\[memory:\s*([a-zA-Z0-9_-]+)\s*\]\s*\n?/;

function isSafeId(s: string | null | undefined): s is string {
  return typeof s === 'string' && SAFE_ID_RE.test(s);
}

export function validateConfig(raw: unknown): RunnerConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('config.json must be a JSON object');
  }
  const c = raw as Record<string, unknown>;
  if (typeof c.endpoint !== 'string' || !/^https?:\/\//.test(c.endpoint)) {
    throw new Error('config.json: "endpoint" must be a string starting with http:// or https://');
  }
  if (typeof c.model !== 'string' || !c.model) {
    throw new Error('config.json: "model" must be a non-empty string');
  }
  if (c.api_key !== undefined) {
    if (typeof c.api_key !== 'string' || c.api_key.length === 0 || c.api_key.length > 512) {
      throw new Error('config.json: "api_key" must be a non-empty string of length <= 512');
    }
  }
  if (c.api_key_env !== undefined) {
    if (typeof c.api_key_env !== 'string' || c.api_key_env.length === 0 || c.api_key_env.length > 64) {
      throw new Error('config.json: "api_key_env" must be a non-empty string of length <= 64');
    }
    if (!ENV_VAR_NAME_RE.test(c.api_key_env)) {
      throw new Error(`config.json: "api_key_env" must match /^[A-Z][A-Z0-9_]*$/ (got ${JSON.stringify(c.api_key_env)})`);
    }
  }
  if (c.api_key !== undefined && c.api_key_env !== undefined) {
    throw new Error('config.json: "api_key" and "api_key_env" are mutually exclusive; pick one');
  }
  if (c.headers !== undefined) {
    if (typeof c.headers !== 'object' || c.headers === null || Array.isArray(c.headers)) {
      throw new Error('config.json: "headers" must be an object of header-name → string');
    }
    for (const [k, v] of Object.entries(c.headers)) {
      if (typeof k !== 'string' || k.length === 0 || k.length > 64) {
        throw new Error(`config.json: headers key must be a string of length 1..64 (got ${JSON.stringify(k)})`);
      }
      if (!HTTP_HEADER_NAME_RE.test(k)) {
        throw new Error(`config.json: headers key ${JSON.stringify(k)} must match /^[A-Za-z][A-Za-z0-9-]*$/`);
      }
      if (RESERVED_HEADER_NAMES_LOWER.has(k.toLowerCase())) {
        throw new Error(`config.json: header ${JSON.stringify(k)} is reserved by the runner (Content-Type, Authorization)`);
      }
      if (typeof v !== 'string' || v.length === 0 || v.length > 512) {
        throw new Error(`config.json: headers[${JSON.stringify(k)}] must be a non-empty string of length <= 512`);
      }
      // Per RFC 7230 §3.2.6, a header field-value is HTAB + visible-ASCII
      // (0x21-0x7E) + SP. Anything outside that range (CR, LF, NUL, other
      // control chars, or bytes >= 0x7F) is rejected by undici's native
      // fetch at call time, which would surface as an uncaught TypeError
      // inside the message loop. Reject at boot instead so the failure
      // surfaces as a clear FATAL config error (Codex pass-2 PR4-010).
      if (/[^\t\x20-\x7e]/.test(v)) {
        throw new Error(
          `config.json: headers[${JSON.stringify(k)}] must contain only HTAB and printable ASCII (0x20-0x7E)`,
        );
      }
    }
  }
  if (c.provider !== undefined) {
    if (typeof c.provider !== 'string' || c.provider.length === 0 || c.provider.length > 32) {
      throw new Error('config.json: "provider" must be a non-empty string of length <= 32');
    }
    if (!PROVIDER_TAG_RE.test(c.provider)) {
      throw new Error(`config.json: "provider" must match /^[a-z][a-z0-9-]*$/ (got ${JSON.stringify(c.provider)})`);
    }
  }
  if (c.max_tokens !== undefined && (typeof c.max_tokens !== 'number' || c.max_tokens < 1 || c.max_tokens > 100000)) {
    throw new Error('config.json: "max_tokens" must be a number in [1, 100000]');
  }
  if (c.temperature !== undefined && (typeof c.temperature !== 'number' || c.temperature < 0 || c.temperature > 2)) {
    throw new Error('config.json: "temperature" must be a number in [0, 2]');
  }
  if (c.heartbeat_interval_sec !== undefined && (typeof c.heartbeat_interval_sec !== 'number' || c.heartbeat_interval_sec < 5)) {
    throw new Error('config.json: "heartbeat_interval_sec" must be a number >= 5');
  }
  if (c.request_timeout_sec !== undefined && (typeof c.request_timeout_sec !== 'number' || c.request_timeout_sec < 1)) {
    throw new Error('config.json: "request_timeout_sec" must be a positive number');
  }
  if (c.tools !== undefined) {
    if (!Array.isArray(c.tools) || c.tools.some(t => typeof t !== 'string')) {
      throw new Error('config.json: "tools" must be an array of strings');
    }
    // Codex M6: fail fast on unknown tool names so a typo doesn't silently
    // ship a tool-less agent that the operator thinks has tools.
    const unknown = (c.tools as string[]).filter(t => !(t in TOOL_REGISTRY));
    if (unknown.length > 0) {
      throw new Error(
        `config.json: unknown tool(s) in "tools": ${unknown.join(', ')}. ` +
        `Available: ${Object.keys(TOOL_REGISTRY).join(', ')}`,
      );
    }
  }
  if (c.tool_loop_max_iterations !== undefined && (typeof c.tool_loop_max_iterations !== 'number' || c.tool_loop_max_iterations < 1)) {
    throw new Error('config.json: "tool_loop_max_iterations" must be a positive number');
  }
  if (c.tool_timeout_sec !== undefined && (typeof c.tool_timeout_sec !== 'number' || c.tool_timeout_sec < 1)) {
    throw new Error('config.json: "tool_timeout_sec" must be a positive number');
  }
  if (c.tool_timeouts_sec !== undefined) {
    // Codex P3-4: validate each entry. Otherwise a typo in a tool name or
    // a string value silently produces broken timeout policy that's hard
    // to diagnose from runtime behavior alone.
    if (typeof c.tool_timeouts_sec !== 'object' || c.tool_timeouts_sec === null || Array.isArray(c.tool_timeouts_sec)) {
      throw new Error('config.json: "tool_timeouts_sec" must be an object of tool-name → seconds');
    }
    for (const [k, v] of Object.entries(c.tool_timeouts_sec)) {
      if (!(k in TOOL_REGISTRY)) {
        throw new Error(
          `config.json: tool_timeouts_sec key "${k}" is not a known tool. ` +
          `Available: ${Object.keys(TOOL_REGISTRY).join(', ')}`,
        );
      }
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 1) {
        throw new Error(`config.json: tool_timeouts_sec["${k}"] must be a finite number >= 1 (got ${JSON.stringify(v)})`);
      }
    }
  }
  if (c.tool_bus_send_budget !== undefined && (typeof c.tool_bus_send_budget !== 'number' || c.tool_bus_send_budget < 0)) {
    throw new Error('config.json: "tool_bus_send_budget" must be a non-negative number');
  }
  return c as unknown as RunnerConfig;
}

/**
 * Resolve the API key for this runner instance. Precedence:
 *
 *   1. cfg.api_key_env → process.env[cfg.api_key_env] — fail-fast if unset.
 *   2. cfg.api_key (committed in config.json — fine for local LLMs that
 *      ignore Authorization, dangerous for hosted providers).
 *   3. process.env.OPENAI_API_KEY (back-compat fallback from PR3 era).
 *
 * Throwing here is caught by the same outer try/catch that wraps
 * validateConfig at main() → emits FATAL: ... on stderr, exit 1.
 *
 * Read once at boot; rotating the secret requires restarting the agent.
 * Documented in templates/agent-thin/AGENTS.md.
 */
/**
 * Materialize the effective HTTP headers to send on every LLM request.
 * Provider-specific defaults (currently: provider="openrouter" injects
 * HTTP-Referer + X-Title for leaderboard attribution) are applied first;
 * the operator's `headers` from config.json are merged on top with
 * case-insensitive dedup, so an operator's lowercase `http-referer`
 * correctly replaces our defaulted `HTTP-Referer` rather than producing
 * two header lines.
 *
 * The reserved-name guard in validateConfig prevents the operator from
 * setting Content-Type or Authorization here; loop.ts's spread order
 * enforces it again at the HTTP boundary as defense-in-depth.
 */
export function resolveExtraHeaders(cfg: RunnerConfig): Record<string, string> {
  const seenLower = new Map<string, string>();
  const result: Record<string, string> = {};

  const setHeader = (key: string, value: string): void => {
    const lc = key.toLowerCase();
    const existing = seenLower.get(lc);
    if (existing !== undefined) {
      delete result[existing];
    }
    seenLower.set(lc, key);
    result[key] = value;
  };

  if (cfg.provider === 'openrouter') {
    setHeader('HTTP-Referer', 'https://github.com/grandamenium/cortextos');
    setHeader('X-Title', 'cortextOS');
  }

  for (const [k, v] of Object.entries(cfg.headers ?? {})) {
    setHeader(k, v);
  }

  return result;
}

export function resolveApiKey(cfg: RunnerConfig): string | undefined {
  if (cfg.api_key_env !== undefined) {
    const v = process.env[cfg.api_key_env];
    if (!v) {
      throw new Error(
        `api_key_env "${cfg.api_key_env}" is unset or empty in the environment`,
      );
    }
    return v;
  }
  if (cfg.api_key !== undefined) return cfg.api_key;
  return process.env['OPENAI_API_KEY'];
}

function parseMemoryDirective(body: string): { threadId: string | null; cleaned: string } {
  const m = body.match(MEMORY_HEADER_RE);
  if (m) {
    return { threadId: m[1] ?? null, cleaned: body.slice(m[0].length).replace(/^\s+/, '') };
  }
  return { threadId: null, cleaned: body };
}

/**
 * Load a thread JSONL into memory. Returns raw entries; the caller should
 * apply sanitizeForLlmReplay() before sending to the LLM (Codex H2).
 */
function loadThread(threadDir: string, threadId: string | null): ThreadMessage[] {
  if (!threadId) return [];
  const path = join(threadDir, `${threadId}.jsonl`);
  if (!existsSync(path)) return [];
  const out: ThreadMessage[] = [];
  const content = readFileSync(path, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as ThreadMessage);
    } catch {
      process.stderr.write(`[openai-runner] thread ${threadId}: skipping malformed line\n`);
    }
  }
  return out;
}

/**
 * Append the user message + the messages the LLM loop produced (assistant
 * turns, role:tool entries) to the thread JSONL. Extends PR2's
 * user+assistant schema additively: tool_calls and role:"tool" entries
 * are preserved verbatim. Old logs (PR2 era) and new logs interleave
 * cleanly because the schema is JSON.
 */
function appendToThread(
  threadDir: string,
  threadId: string | null,
  userText: string,
  newMessages: ThreadMessage[],
): void {
  if (!threadId) return;
  mkdirSync(threadDir, { recursive: true });
  const path = join(threadDir, `${threadId}.jsonl`);
  const lines: string[] = [JSON.stringify({ role: 'user', content: userText })];
  for (const m of newMessages) {
    lines.push(JSON.stringify(m));
  }
  appendFileSync(path, lines.join('\n') + '\n');
}

function stripOuterFences(lines: string[]): string {
  let start = 0;
  let end = lines.length;
  if (start < end && lines[start]!.trim() === '```') start++;
  if (end > start && lines[end - 1]!.trim() === '```') end--;
  return lines.slice(start, end).join('\n').replace(/\s+$/, '');
}

async function* readBlocks(): AsyncGenerator<ParsedMessage> {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  let sender: string | null = null;
  let msgId: string | null = null;
  let collected: string[] = [];
  let inMessage = false;

  for await (const line of rl) {
    if (line.startsWith('=== AGENT MESSAGE')) {
      if (inMessage) {
        process.stderr.write(
          `[openai-runner] malformed envelope: new AGENT MESSAGE header before terminator — ` +
          `dropping partial msg_id=${msgId ?? '(unknown)'}\n`,
        );
      }
      const m = line.match(HEADER_RE);
      if (m && isSafeId(m[1]) && isSafeId(m[3])) {
        sender = m[1]!;
        msgId = m[3]!;
        collected = [];
        inMessage = true;
      } else {
        process.stderr.write(`[openai-runner] header did not match expected shape, skipping: ${line}\n`);
        sender = null;
        msgId = null;
        collected = [];
        inMessage = false;
      }
    } else if (inMessage && TERMINATOR_RE.test(line)) {
      const body = stripOuterFences(collected);
      yield { sender: sender!, msgId: msgId!, body };
      sender = null;
      msgId = null;
      collected = [];
      inMessage = false;
    } else if (inMessage) {
      collected.push(line);
    }
  }

  if (inMessage) {
    process.stderr.write(
      `[openai-runner] EOF mid-message — dropping partial msg_id=${msgId ?? '(unknown)'}\n`,
    );
  }
}

/**
 * Read the enabled-agents.json registry into a set of agent names so
 * `bus_send_message` can validate its `to` argument before sending
 * (Codex M3 — prevents silent dead letters to nonexistent agents).
 *
 * The registry path is `~/.cortextos/<instance>/config/enabled-agents.json`
 * — same shape `add-agent.ts` writes. Missing or unparseable file → empty
 * set (the tool just rejects every target, which is the safe default).
 */
function loadEnabledAgentsRegistry(instanceId: string): Set<string> {
  const path = join(homedir(), '.cortextos', instanceId, 'config', 'enabled-agents.json');
  if (!existsSync(path)) return new Set();
  try {
    const obj = JSON.parse(readFileSync(path, 'utf-8'));
    if (!obj || typeof obj !== 'object') return new Set();
    return new Set(
      Object.entries(obj)
        .filter(([, v]) => v && typeof v === 'object' && (v as Record<string, unknown>).enabled !== false)
        .map(([k]) => k),
    );
  } catch {
    return new Set();
  }
}

export const runOpenAIAgentCommand = new Command('run-openai-agent')
  .description('Internal: runtime entry point for openai-compatible specialist agents (invoked by the daemon\'s PTY adapter, not by users directly)')
  .action(async () => {
    const agentName = process.env.CTX_AGENT_NAME;
    const agentDir = process.env.CTX_AGENT_DIR;
    const org = process.env.CTX_ORG ?? '';
    const instanceId = process.env.CTX_INSTANCE_ID ?? 'default';

    if (!agentName || !agentDir) {
      process.stderr.write('FATAL: CTX_AGENT_NAME and CTX_AGENT_DIR must be set.\n');
      process.exit(1);
    }

    const configPath = join(agentDir, 'config.json');
    const systemPromptPath = join(agentDir, 'SYSTEM_PROMPT.md');
    if (!existsSync(configPath)) {
      process.stderr.write(`FATAL: missing ${configPath}\n`);
      process.exit(1);
    }
    if (!existsSync(systemPromptPath)) {
      process.stderr.write(`FATAL: missing ${systemPromptPath}\n`);
      process.exit(1);
    }

    let cfg: RunnerConfig;
    let systemPrompt: string;
    let apiKey: string | undefined;
    try {
      cfg = validateConfig(JSON.parse(readFileSync(configPath, 'utf-8')));
      systemPrompt = readFileSync(systemPromptPath, 'utf-8').trim();
      apiKey = resolveApiKey(cfg);
    } catch (err) {
      process.stderr.write(`FATAL: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
      return;
    }

    const endpoint = cfg.endpoint.replace(/\/$/, '');
    const model = cfg.model;
    const extraHeaders = resolveExtraHeaders(cfg);
    const maxTokens = cfg.max_tokens ?? 2000;
    const temperature = cfg.temperature ?? 0.2;
    const heartbeatMs = (cfg.heartbeat_interval_sec ?? 60) * 1000;
    const requestTimeoutMs = (cfg.request_timeout_sec ?? 120) * 1000;

    // Tool config
    const enabledTools = cfg.tools ?? [];
    const maxIterations = cfg.tool_loop_max_iterations ?? 5;
    // Codex P3-2: keep undefined when no global override is set so the loop's
    // precedence chain (per-tool > global > registry.defaultTimeoutMs > 10s)
    // actually reaches the per-definition default. Materializing to 10000
    // here would mask every tool's defaultTimeoutMs silently.
    const defaultToolTimeoutMs = cfg.tool_timeout_sec === undefined
      ? undefined
      : cfg.tool_timeout_sec * 1000;
    const toolTimeoutsMs: Record<string, number> = {};
    for (const [k, v] of Object.entries(cfg.tool_timeouts_sec ?? {})) {
      toolTimeoutsMs[k] = v * 1000;
    }
    const sendBudget = cfg.tool_bus_send_budget ?? 3;
    // Cached per-process flag: flipped to false on the first endpoint
    // rejection of `tools` so we don't keep retrying. Lives across all
    // inbox messages handled by this runner instance.
    const toolsSupported = { value: true };

    const paths = resolvePaths(agentName, instanceId, org || undefined);
    const threadDir = join(paths.stateDir, 'threads');
    const enabledAgentsRegistry = loadEnabledAgentsRegistry(instanceId);

    let currentStatus = 'starting';
    let currentTask = '';

    function safeUpdateHeartbeat(status: string, task: string): void {
      currentStatus = status;
      currentTask = task;
      try {
        updateHeartbeat(paths, agentName!, status, {
          org: org || undefined,
          timezone: cfg.heartbeat_interval_sec !== undefined ? undefined : process.env['CTX_TIMEZONE'],
          currentTask: task,
        });
      } catch (err) {
        process.stderr.write(`[openai-runner] heartbeat failed: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }

    function safeLogEvent(category: 'milestone' | 'task' | 'error', name: string, severity: 'info' | 'warning' | 'error', meta: Record<string, unknown>): void {
      try {
        logEvent(paths, agentName!, org, category, name, severity, meta);
      } catch (err) {
        process.stderr.write(`[openai-runner] log-event failed: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }

    // Register the SIGTERM trap BEFORE any startup bus calls (or the READY
    // emit) — see PR2 Codex P2-1 fix.
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let shuttingDown = false;
    const shutdown = (): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      safeUpdateHeartbeat('stopping', currentTask);
      safeLogEvent('milestone', 'agent_offline', 'info', { agent: agentName, model });
      process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    safeUpdateHeartbeat('idle', '');
    safeLogEvent('milestone', 'agent_online', 'info', {
      agent: agentName, model, endpoint, tools: enabledTools,
      ...(cfg.provider ? { provider: cfg.provider } : {}),
    });

    process.stdout.write('[openai-runner] READY\n');

    heartbeatTimer = setInterval(() => {
      safeUpdateHeartbeat(currentStatus, currentTask);
    }, heartbeatMs);

    // PR4 Codex pass-1 PR4-005: count consecutive 401/403 responses from
    // the LLM endpoint so the runner can exit after a small budget,
    // letting PM2 surface "errored" rather than flapping silently.
    let consecutiveAuthFailures = 0;
    const AUTH_FAILURE_LIMIT = 3;

    try {
      for await (const { sender, msgId, body } of readBlocks()) {
        safeUpdateHeartbeat('working', `answering ${sender}`);
        try {
          const { threadId, cleaned } = parseMemoryDirective(body);
          const rawHistory = loadThread(threadDir, threadId);
          const cleanHistory = sanitizeForLlmReplay(rawHistory);

          const initialMessages: ThreadMessage[] = [
            { role: 'system', content: systemPrompt },
            ...cleanHistory,
            { role: 'user', content: cleaned },
          ];

          const { finalContent, appendMessages, hitMaxIterations } = await callLlmWithTools(
            initialMessages,
            {
              endpoint, apiKey, model, maxTokens, temperature, requestTimeoutMs,
              toolsSupported,
              extraHeaders,
              enabledToolNames: enabledTools,
              defaultToolTimeoutMs,
              toolTimeoutsMs,
              maxIterations,
              sendBudget,
              onProgress: safeUpdateHeartbeat,
              busPaths: paths,
              agentName,
              org,
              toolContext: {
                agentName,
                agentDir,
                paths,
                org,
                currentInboxMsgId: msgId,
                enabledAgentsRegistry,
              },
            },
          );

          appendToThread(threadDir, threadId, cleaned, appendMessages);
          const safeAnswer = stripControlChars(finalContent);
          sendMessage(paths, agentName, sender, 'normal', safeAnswer, msgId);
          ackInbox(paths, msgId);

          if (hitMaxIterations) {
            safeLogEvent('error', 'task_failed', 'warning', {
              msg_id: msgId, reason: 'tool_loop_max_iterations_exceeded',
            });
          } else {
            safeLogEvent('task', 'task_completed', 'info', { answered: sender, msg_id: msgId });
          }
          // A successful turn (with or without max-iterations) means the
          // upstream auth is working; reset the failure counter so an
          // intermittent 401 doesn't accumulate forever.
          consecutiveAuthFailures = 0;
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[openai-runner] task failed for ${msgId}: ${errMsg}\n`);
          // Codex M4: graceful context-window failure with a user-visible
          // reply rather than a silent ack-and-drop.
          let userFacing = 'task failed';
          // PR4 Codex pass-1 PR4-005: detect upstream 401/403 and surface
          // an actionable hint instead of "task failed". The redactSecrets
          // pass in loop.ts has already scrubbed the key from errMsg, so
          // it's safe to expose the HTTP status to the operator.
          const authMatch = errMsg.match(/^LLM HTTP (401|403):/);
          if (authMatch) {
            consecutiveAuthFailures++;
            const httpStatus = authMatch[1];
            const keySource = cfg.api_key_env
              ? `api_key_env ${cfg.api_key_env}`
              : (cfg.api_key ? 'api_key (literal in config.json)' : 'OPENAI_API_KEY env fallback');
            const providerName = cfg.provider ?? 'unknown';
            userFacing =
              `LLM authentication failed for provider ${providerName} ` +
              `(HTTP ${httpStatus} from ${endpoint}). Check ${keySource} ` +
              `and restart the agent.`;
            safeLogEvent('error', 'agent_auth_failed', 'error', {
              msg_id: msgId,
              status: Number(httpStatus),
              provider: cfg.provider,
              api_key_env: cfg.api_key_env,
              endpoint,
              consecutive_failures: consecutiveAuthFailures,
            });
          } else if (errMsg.startsWith('CONTEXT_WINDOW:')) {
            userFacing = 'I exceeded the context window for this conversation. Please ask a more focused question or start a new thread.';
            safeLogEvent('error', 'task_failed', 'error', { msg_id: msgId, reason: 'context_window_exceeded' });
          } else {
            safeLogEvent('error', 'task_failed', 'error', { msg_id: msgId, error: errMsg });
          }
          try {
            sendMessage(paths, agentName, sender, 'normal', userFacing, msgId);
          } catch { /* sender lookup may also fail — drop quietly */ }
          try { ackInbox(paths, msgId); } catch { /* already gone */ }

          // PR4 Codex pass-1 PR4-005: exit after three consecutive auth
          // failures so PM2 surfaces the unhealthy state rather than the
          // agent silently failing every inbox message forever.
          if (consecutiveAuthFailures >= AUTH_FAILURE_LIMIT) {
            process.stderr.write(
              `[openai-runner] ${consecutiveAuthFailures} consecutive auth failures — exiting so PM2 surfaces the error\n`,
            );
            safeLogEvent('error', 'agent_auth_failed', 'error', {
              reason: 'consecutive_auth_failure_limit',
              limit: AUTH_FAILURE_LIMIT,
              endpoint,
            });
            process.exit(1);
          }
        } finally {
          safeUpdateHeartbeat('idle', '');
        }
      }
    } finally {
      shutdown();
    }
  });
