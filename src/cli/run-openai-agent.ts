import { Command } from 'commander';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import * as readline from 'readline';
import { sendMessage, ackInbox, updateHeartbeat, logEvent } from '../bus/index.js';
import { resolvePaths } from '../utils/paths.js';
import { stripControlChars } from '../utils/validate.js';

interface RunnerConfig {
  endpoint: string;
  model: string;
  api_key?: string;
  max_tokens?: number;
  temperature?: number;
  heartbeat_interval_sec?: number;
  request_timeout_sec?: number;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ParsedMessage {
  sender: string;
  msgId: string;
  body: string;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
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
 *
 * The body's outer ``` fences delimit the user payload. The terminator is a
 * full-line match on the exact Reply-using line, NOT a "Reply using:" prefix —
 * a body legitimately containing that phrase must not trigger an early end.
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
  return c as unknown as RunnerConfig;
}

function parseMemoryDirective(body: string): { threadId: string | null; cleaned: string } {
  const m = body.match(MEMORY_HEADER_RE);
  if (m) {
    return { threadId: m[1] ?? null, cleaned: body.slice(m[0].length).replace(/^\s+/, '') };
  }
  return { threadId: null, cleaned: body };
}

function loadThread(threadDir: string, threadId: string | null): ChatMessage[] {
  if (!threadId) return [];
  const path = join(threadDir, `${threadId}.jsonl`);
  if (!existsSync(path)) return [];
  const out: ChatMessage[] = [];
  const content = readFileSync(path, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as ChatMessage);
    } catch {
      process.stderr.write(`[openai-runner] thread ${threadId}: skipping malformed line\n`);
    }
  }
  return out;
}

function appendToThread(threadDir: string, threadId: string | null, userText: string, assistantText: string): void {
  if (!threadId) return;
  mkdirSync(threadDir, { recursive: true });
  const path = join(threadDir, `${threadId}.jsonl`);
  // appendFileSync (not atomicWriteSync) matches the house JSONL pattern in
  // src/bus/event.ts:65 and src/daemon/agent-process.ts. atomic.ts is whole-
  // file write+rename; using it per-record would overwrite prior history.
  appendFileSync(
    path,
    JSON.stringify({ role: 'user', content: userText }) + '\n' +
    JSON.stringify({ role: 'assistant', content: assistantText }) + '\n',
  );
}

function stripOuterFences(lines: string[]): string {
  // Drop a leading ``` (the opening fence after the AGENT MESSAGE header)
  // and a trailing ``` (the closing fence before the terminator). Inner
  // ``` lines belong to the body and are preserved untouched.
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
    // Lines outside any envelope are ignored — daemon noise, blank lines
    // from the trailing \r that inject.ts sends 300ms after the paste, etc.
  }

  if (inMessage) {
    process.stderr.write(
      `[openai-runner] EOF mid-message — dropping partial msg_id=${msgId ?? '(unknown)'}\n`,
    );
  }
}

async function callLlm(
  endpoint: string,
  apiKey: string | undefined,
  model: string,
  systemPrompt: string,
  body: string,
  history: ChatMessage[],
  maxTokens: number,
  temperature: number,
  timeoutMs: number,
): Promise<string> {
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: body },
  ];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(`${endpoint}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature }),
      signal: controller.signal,
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      throw new Error(`LLM HTTP ${r.status}: ${errText.slice(0, 500)}`);
    }
    const j = (await r.json()) as ChatCompletionResponse;
    const answer = (j.choices?.[0]?.message?.content ?? '').trim();
    if (!answer) {
      throw new Error('LLM returned empty response');
    }
    return answer;
  } finally {
    clearTimeout(timer);
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
    try {
      cfg = validateConfig(JSON.parse(readFileSync(configPath, 'utf-8')));
      systemPrompt = readFileSync(systemPromptPath, 'utf-8').trim();
    } catch (err) {
      process.stderr.write(`FATAL: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
      return;
    }

    const endpoint = cfg.endpoint.replace(/\/$/, '');
    const model = cfg.model;
    const maxTokens = cfg.max_tokens ?? 2000;
    const temperature = cfg.temperature ?? 0.2;
    const heartbeatMs = (cfg.heartbeat_interval_sec ?? 60) * 1000;
    const requestTimeoutMs = (cfg.request_timeout_sec ?? 120) * 1000;
    const apiKey = cfg.api_key ?? process.env['OPENAI_API_KEY'];

    const paths = resolvePaths(agentName, instanceId, org || undefined);
    const threadDir = join(paths.stateDir, 'threads');

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
    // emit) so a daemon-initiated stop arriving mid-boot still flushes the
    // 'stopping' heartbeat + agent_offline event. Without this, AgentProcess
    // signalShutdown → SIGTERM could land in the race window between
    // bootstrap and `process.on(...)`, causing the default-action terminate.
    // The heartbeat timer is created later (inside startHeartbeatLoop) — the
    // shutdown handler tolerates a null timer for early-shutdown safety.
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let shuttingDown = false;
    const shutdown = (): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      safeUpdateHeartbeat('stopping', currentTask);
      safeLogEvent('milestone', 'agent_offline', 'info', { agent: agentName, model });
      // Disk writes are sync (atomicWriteSync / appendFileSync); by the time
      // those calls return the file content is in the page cache.
      process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    safeUpdateHeartbeat('idle', '');
    safeLogEvent('milestone', 'agent_online', 'info', { agent: agentName, model, endpoint });

    // Bootstrap signal — the PTY adapter watches for this exact line to mark
    // the agent as ready for message injection. Must match
    // src/pty/openai-compatible-pty.ts:BOOTSTRAP_PATTERN.
    process.stdout.write('[openai-runner] READY\n');

    heartbeatTimer = setInterval(() => {
      safeUpdateHeartbeat(currentStatus, currentTask);
    }, heartbeatMs);

    try {
      for await (const { sender, msgId, body } of readBlocks()) {
        safeUpdateHeartbeat('working', `answering ${sender}`);
        try {
          const { threadId, cleaned } = parseMemoryDirective(body);
          const history = loadThread(threadDir, threadId);
          const answer = await callLlm(
            endpoint, apiKey, model, systemPrompt, cleaned, history,
            maxTokens, temperature, requestTimeoutMs,
          );
          appendToThread(threadDir, threadId, cleaned, answer);
          const safeAnswer = stripControlChars(answer);
          sendMessage(paths, agentName, sender, 'normal', safeAnswer, msgId);
          ackInbox(paths, msgId);
          safeLogEvent('task', 'task_completed', 'info', { answered: sender, msg_id: msgId });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[openai-runner] task failed for ${msgId}: ${errMsg}\n`);
          safeLogEvent('error', 'task_failed', 'error', { msg_id: msgId, error: errMsg });
          // Ack the poison message — better dropped than re-looped on every
          // restart. The error event captures the loss for postmortem.
          try { ackInbox(paths, msgId); } catch { /* already gone */ }
        } finally {
          safeUpdateHeartbeat('idle', '');
        }
      }
    } finally {
      shutdown();
    }
  });
