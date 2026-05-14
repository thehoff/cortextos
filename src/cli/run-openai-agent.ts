import { Command } from 'commander';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import * as readline from 'readline';
import { sendMessage, ackInbox, updateHeartbeat, logEvent } from '../bus/index.js';
import { resolvePaths } from '../utils/paths.js';
import { stripControlChars } from '../utils/validate.js';
import { callLlmWithTools, redactSecrets } from '../openai-runner/loop.js';
import { sanitizeForLlmReplay, type ThreadMessage } from '../openai-runner/sanitize-thread-replay.js';
import {
  validateConfig,
  resolveApiKey,
  resolveExtraHeaders,
  type RunnerConfig,
} from '../openai-runner/config.js';
import { bootMcpManager } from '../openai-runner/mcp/manager.js';
import type { McpManager } from '../openai-runner/mcp/manager.js';
import { TOOL_REGISTRY } from '../openai-runner/tools/index.js';

// Re-export for back-compat with tests that import from this module.
export { validateConfig, resolveApiKey, resolveExtraHeaders };
export type { RunnerConfig };

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

    // Tool config. Per PLAN.md §8.2 (Codex pass-2 PR5-014):
    //   - cfg.tools undefined  → ALL builtins + ALL MCP tools enabled
    //   - cfg.tools: []        → no tools at all
    //   - cfg.tools: [...]     → exactly the listed tools
    // The all-enabled materialization happens AFTER MCP boot (it needs the
    // manager's discovered tools), so the variable is `let` here.
    let enabledTools: string[] = cfg.tools === undefined ? [] : cfg.tools;
    const enabledToolsAbsent = cfg.tools === undefined;
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
    // PR5: mcpManager populated AFTER bootMcpManager resolves. The shutdown
    // handler can race with boot — onBeforeFirstSpawn handoff gives the
    // signal trap access to a still-booting manager via partialMcpShutdown.
    let mcpManager: McpManager | undefined;
    let partialMcpShutdown: (() => Promise<void>) | undefined;
    // PR5-025 (Codex pass-3): sink for $VAR-resolved secrets. Populated by
    // the manager as it walks specs so we have them in hand even when boot
    // rejects mid-flight — the catch path below redacts the FATAL stderr
    // line through this set.
    const collectedMcpSecrets = new Set<string>();
    const SHUTDOWN_OUTER_BUDGET_MS = 5_000;
    // PR5-024 (Codex pass-3 BLOCKER) side-effect: with the SIGTERM
    // handler now awaiting MCP teardown, a Promise rejected concurrently
    // by the in-flight bootMcpManager (when manager.shutdown closes its
    // transports the SDK fires `Connection closed`) can land as an
    // "unhandledRejection" between async microtasks even though the boot
    // call site has its own try/catch. Suppressing the rejection ONLY
    // during shutdown lets the signal handler reach `process.exit(0)`;
    // any uncaught error or rejection OUTSIDE the shutdown race remains
    // fatal (Codex pass-4 PR5-040 — silent-survive-with-broken-state
    // would be worse than a hard crash that PM2 can surface). Log lines
    // are redacted with the API key + collected MCP secrets so they
    // can't leak secrets into operator logs.
    process.on('uncaughtException', (err) => {
      const raw = err instanceof Error ? (err.stack ?? err.message) : String(err);
      const safe = redactSecrets(raw, apiKey, collectedMcpSecrets);
      process.stderr.write(`[openai-runner] uncaught exception: ${safe}\n`);
      if (!shuttingDown) {
        process.exit(1);
      }
    });
    process.on('unhandledRejection', (reason) => {
      const raw = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
      const safe = redactSecrets(raw, apiKey, collectedMcpSecrets);
      process.stderr.write(`[openai-runner] unhandled rejection: ${safe}\n`);
      if (!shuttingDown) {
        process.exit(1);
      }
    });
    const shutdown = async (): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      process.stderr.write(`[openai-runner] shutdown begin (mcp=${mcpManager ? 'ready' : (partialMcpShutdown ? 'booting' : 'none')})\n`);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      safeUpdateHeartbeat('stopping', currentTask);
      safeLogEvent('milestone', 'agent_offline', 'info', { agent: agentName, model });
      // PR5-024 (Codex pass-3 BLOCKER): await MCP teardown with an outer
      // 5s race so a stuck child can't block SIGTERM compliance. The
      // manager has its own internal budget but the outer race is
      // defense-in-depth for unexpected wedge paths.
      const closer = mcpManager?.shutdown ?? partialMcpShutdown;
      if (closer) {
        await Promise.race([
          closer().catch(() => undefined),
          new Promise<void>(resolve => setTimeout(resolve, SHUTDOWN_OUTER_BUDGET_MS)),
        ]);
      }
      process.stderr.write('[openai-runner] shutdown done\n');
      process.exit(0);
    };
    process.on('SIGTERM', () => { process.stderr.write('[openai-runner] sigterm\n'); void shutdown(); });
    process.on('SIGINT', () => { process.stderr.write('[openai-runner] sigint\n'); void shutdown(); });

    // PR5: boot MCP servers between config-load and READY. Failures FATAL.
    if (cfg.mcp_servers && cfg.mcp_servers.length > 0) {
      // Emit a stable marker AFTER the signal handlers are registered but
      // BEFORE the boot await. Tests use this to synchronize SIGTERM
      // delivery to a known mid-boot point — without it they would race
      // tsx's startup latency.
      process.stderr.write('[openai-runner] MCP_BOOT_BEGIN\n');
      const mcpBootTimeoutMs = (cfg.mcp_boot_timeout_sec ?? 30) * 1000;
      // Codex pass-2 PR5-016: fold cfg.tool_timeout_sec into the chain so an
      // operator who set a global per-tool timeout in PR3 actually affects
      // MCP tools too.
      const mcpDefaultToolTimeoutMs = (cfg.mcp_tool_timeout_sec ?? cfg.tool_timeout_sec ?? 30) * 1000;
      try {
        mcpManager = await bootMcpManager({
          specs: cfg.mcp_servers,
          cwd: agentDir,
          bootTimeoutMs: mcpBootTimeoutMs,
          defaultToolTimeoutMs: mcpDefaultToolTimeoutMs,
          builtinToolNames: new Set(Object.keys(TOOL_REGISTRY)),
          runnerEnv: process.env,
          onBeforeFirstSpawn: (handle) => { partialMcpShutdown = handle.shutdown; },
          // PR5-025 (Codex pass-3): give the manager our pre-allocated
          // secrets Set so resolved $VAR values are visible to the
          // FATAL-error redaction below even if boot rejects.
          secretsSink: collectedMcpSecrets,
        });
        // Phase-2: any tools[] entry that was syntactically mcp__<server>__<tool>
        // at config-validation time must now exist in the route table. A typo
        // in the tool-name portion (right shape, wrong tool) fails here.
        for (const enabled of enabledTools) {
          if (enabled.startsWith('mcp__') && !(enabled in TOOL_REGISTRY) && !mcpManager.routes.has(enabled)) {
            throw new Error(
              `config.json: "tools" lists "${enabled}" but no MCP server advertises that tool. ` +
              `Available MCP tools: ${[...mcpManager.routes.keys()].join(', ') || '(none)'}`,
            );
          }
        }
        // PR5-014 (HIGH): absent `tools` means ALL enabled. Materialize the
        // full set after MCP boot now that the route table is final.
        if (enabledToolsAbsent) {
          enabledTools = [...Object.keys(TOOL_REGISTRY), ...mcpManager.routes.keys()];
        }
      } catch (err) {
        const rawMsg = err instanceof Error ? err.message : String(err);
        // PR5-025 (Codex pass-3 MAJOR): redact API key + any $VAR-resolved
        // secrets that were collected before boot rejected. Without this,
        // a partial spec-walk that resolved a SECRET_KEY before a later
        // spec hung could echo that key into the FATAL stderr line.
        const msg = redactSecrets(rawMsg, apiKey, collectedMcpSecrets);
        process.stderr.write(`FATAL: MCP boot failed: ${msg}\n`);
        try { await mcpManager?.shutdown(); } catch { /* */ }
        try { await partialMcpShutdown?.(); } catch { /* */ }
        process.exit(1);
        return;
      }
    }

    safeUpdateHeartbeat('idle', '');
    safeLogEvent('milestone', 'agent_online', 'info', {
      agent: agentName, model, endpoint, tools: enabledTools,
      ...(cfg.provider ? { provider: cfg.provider } : {}),
      ...(mcpManager
        ? {
          mcp_servers: [...mcpManager.clients.keys()],
          mcp_tools_count: mcpManager.routes.size,
        }
        : {}),
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
              mcpManager,
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
      await shutdown();
    }
  });
