/**
 * PR3 (tool use): end-to-end tool loop via the spawned runner.
 *
 * Mock LLM script: turn 1 returns a tool_call for get_current_time,
 * turn 2 returns the final answer that incorporates the tool result.
 * Asserts:
 *   - The runner actually invokes the tool (i.e. the second LLM request
 *     includes a `role:"tool"` message with the tool result).
 *   - The thread JSONL records the new schema (tool_calls + role:tool).
 *   - tool_call_started/tool_call_finished events land in analytics.
 *   - The user's inbox gets the final reply.
 *
 * Also pins history replay: a second inbox message in the same thread
 * sends a sanitized history into the next LLM call.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { createServer, type Server } from 'http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { AddressInfo } from 'net';

const TSX_BIN = join(__dirname, '..', '..', 'node_modules', '.bin', 'tsx');
const CLI_SRC = join(__dirname, '..', '..', 'src', 'cli', 'index.ts');
const RUN_ARGS = [CLI_SRC, 'run-openai-agent'];

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

interface CompletionRequest {
  model: string;
  messages: any[];
  tools?: any[];
}

type ScriptedReply =
  | { type: 'tool_call'; calls: Array<{ id: string; name: string; arguments: string }> }
  | { type: 'final'; content: string };

describe('PR3: runner tool loop end-to-end', { timeout: 30_000 }, () => {
  let tempRoot: string;
  let agentDir: string;
  let ctxRoot: string;
  let proc: ChildProcess | null = null;
  let mockServer: Server;
  let endpoint: string;
  let llmRequests: CompletionRequest[];
  let scriptedReplies: ScriptedReply[];

  beforeEach(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'pr3-tool-loop-'));
    agentDir = join(tempRoot, 'project', 'orgs', 'acme', 'agents', 'rag-t');
    ctxRoot = join(tempRoot, '.cortextos', 'tool-loop-test');
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(ctxRoot, { recursive: true });
    // Seed an enabled-agents.json so bus_send_message tool tests have a
    // valid registry (not used in this file, but keeps the runner happy).
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    writeFileSync(
      join(ctxRoot, 'config', 'enabled-agents.json'),
      JSON.stringify({ 'rag-t': { enabled: true, org: 'acme' } }),
    );

    llmRequests = [];
    scriptedReplies = [];

    mockServer = createServer((req, res) => {
      if (req.method !== 'POST' || !req.url?.endsWith('/v1/chat/completions')) {
        res.statusCode = 404;
        res.end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        llmRequests.push(body);
        const idx = llmRequests.length - 1;
        const reply = scriptedReplies[idx];
        res.setHeader('Content-Type', 'application/json');
        if (!reply || reply.type === 'final') {
          res.end(JSON.stringify({
            choices: [{ message: { role: 'assistant', content: reply?.type === 'final' ? reply.content : '(no scripted reply)' } }],
          }));
        } else {
          res.end(JSON.stringify({
            choices: [{
              message: {
                role: 'assistant',
                content: null,
                tool_calls: reply.calls.map(c => ({
                  id: c.id,
                  type: 'function',
                  function: { name: c.name, arguments: c.arguments },
                })),
              },
            }],
          }));
        }
      });
    });

    await new Promise<void>(resolve => mockServer.listen(0, '127.0.0.1', () => resolve()));
    const port = (mockServer.address() as AddressInfo).port;
    endpoint = `http://127.0.0.1:${port}`;

    writeFileSync(join(agentDir, 'config.json'), JSON.stringify({
      agent_name: 'rag-t',
      runtime: 'openai-compatible',
      enabled: true,
      endpoint,
      model: 'test-model',
      heartbeat_interval_sec: 60,
      request_timeout_sec: 10,
      tools: ['get_current_time', 'kb_search'],
    }));
    writeFileSync(join(agentDir, 'SYSTEM_PROMPT.md'), 'You are a test assistant.');
    mkdirSync(join(agentDir, 'memory'), { recursive: true });
    writeFileSync(join(agentDir, 'memory', 'secrets.md'), 'The secret word is hummingbird.');
  });

  afterEach(async () => {
    if (proc && !proc.killed) {
      proc.kill('SIGKILL');
      await new Promise<void>(resolve => proc!.once('exit', () => resolve()));
    }
    await new Promise<void>(resolve => mockServer.close(() => resolve()));
    await sleep(50);
    try { rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* best-effort */ }
  });

  async function waitForReady(child: ChildProcess, timeoutMs = 10_000): Promise<void> {
    const start = Date.now();
    let buffer = '';
    return new Promise((resolve, reject) => {
      const onData = (chunk: Buffer): void => {
        buffer += chunk.toString();
        if (buffer.includes('[openai-runner] READY')) {
          child.stdout!.off('data', onData);
          resolve();
        } else if (Date.now() - start > timeoutMs) {
          child.stdout!.off('data', onData);
          reject(new Error(`READY not seen within ${timeoutMs}ms.\nstdout so far:\n${buffer}`));
        }
      };
      child.stdout!.on('data', onData);
    });
  }

  function buildMessage(sender: string, msgId: string, body: string): string {
    return [
      `=== AGENT MESSAGE from ${sender} [msg_id: ${msgId}] ===`,
      '```',
      body,
      '```',
      `Reply using: cortextos bus send-message ${sender} normal '<your reply>' ${msgId}`,
      '',
    ].join('\n');
  }

  function spawnRunner(): ChildProcess {
    return spawn(TSX_BIN, RUN_ARGS, {
      env: {
        ...process.env,
        HOME: tempRoot,
        CTX_AGENT_NAME: 'rag-t',
        CTX_AGENT_DIR: agentDir,
        CTX_ORG: 'acme',
        CTX_INSTANCE_ID: 'tool-loop-test',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  async function waitForLlmCallCount(target: number, timeoutMs = 10_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (llmRequests.length >= target) return;
      await sleep(50);
    }
    throw new Error(`Expected ${target} LLM call(s); saw ${llmRequests.length} within ${timeoutMs}ms`);
  }

  it('a tool_call response triggers tool execution + a follow-up LLM call with the result', async () => {
    scriptedReplies = [
      { type: 'tool_call', calls: [{ id: 'c1', name: 'get_current_time', arguments: '{}' }] },
      { type: 'final', content: 'The current time is captured.' },
    ];
    proc = spawnRunner();
    await waitForReady(proc);

    proc.stdin!.write(buildMessage('human', 'msg-1', '[memory: time-thread]\nWhat time is it?'));
    await waitForLlmCallCount(2);
    await sleep(300);

    // First request: system + user, with tools parameter.
    expect(llmRequests[0]!.tools).toBeDefined();
    expect(llmRequests[0]!.tools!.map((t: any) => t.function.name)).toEqual(
      expect.arrayContaining(['get_current_time', 'kb_search']),
    );
    expect(llmRequests[0]!.messages.map((m: any) => m.role)).toEqual(['system', 'user']);

    // Second request: system + user + assistant(tool_calls) + tool.
    expect(llmRequests[1]!.messages.map((m: any) => m.role)).toEqual([
      'system', 'user', 'assistant', 'tool',
    ]);
    const toolMsg = llmRequests[1]!.messages[3]!;
    expect(toolMsg.tool_call_id).toBe('c1');
    const toolResult = JSON.parse(toolMsg.content);
    expect(toolResult.utc).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Thread JSONL contains the new schema.
    const threadPath = join(ctxRoot, 'state', 'rag-t', 'threads', 'time-thread.jsonl');
    expect(existsSync(threadPath)).toBe(true);
    const lines = readFileSync(threadPath, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    expect(lines.length).toBe(4); // user, assistant(tool_calls), tool, assistant(final)
    expect(lines[1].tool_calls).toBeDefined();
    expect(lines[2].role).toBe('tool');
    expect(lines[2].tool_call_id).toBe('c1');
    expect(lines[3].content).toBe('The current time is captured.');

    // tool_call_started + tool_call_finished events landed in analytics.
    const today = new Date().toISOString().split('T')[0];
    const eventFile = join(ctxRoot, 'orgs', 'acme', 'analytics', 'events', 'rag-t', `${today}.jsonl`);
    const events = readFileSync(eventFile, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    const started = events.find(e => e.event === 'tool_call_started' && e.metadata.tool === 'get_current_time');
    const finished = events.find(e => e.event === 'tool_call_finished' && e.metadata.tool === 'get_current_time');
    expect(started).toBeDefined();
    expect(finished).toBeDefined();
    expect(finished.metadata.status).toBe('success');
    expect(typeof finished.metadata.duration_ms).toBe('number');

    // Final reply lands in human's inbox.
    const humanInbox = join(ctxRoot, 'inbox', 'human');
    const inboxFiles = require('fs').readdirSync(humanInbox).filter((f: string) => f.endsWith('.json'));
    expect(inboxFiles.length).toBe(1);
    const reply = JSON.parse(readFileSync(join(humanInbox, inboxFiles[0]), 'utf-8'));
    expect(reply.text).toBe('The current time is captured.');
    expect(reply.reply_to).toBe('msg-1');
  });

  it('history replay: second inbox message in same thread sends sanitized prior turn', async () => {
    scriptedReplies = [
      // Turn 1
      { type: 'tool_call', calls: [{ id: 'c1', name: 'get_current_time', arguments: '{}' }] },
      { type: 'final', content: 'It is 2026-05-13.' },
      // Turn 2 — no tool calls needed, just answer.
      { type: 'final', content: 'Yes, it is May 13.' },
    ];
    proc = spawnRunner();
    await waitForReady(proc);

    proc.stdin!.write(buildMessage('human', 'msg-1', '[memory: date-thread]\nWhat is today?'));
    await waitForLlmCallCount(2);
    await sleep(300);

    proc.stdin!.write(buildMessage('human', 'msg-2', '[memory: date-thread]\nIs that in May?'));
    await waitForLlmCallCount(3);
    await sleep(300);

    // Third LLM request: should contain system + (prior turn history,
    // sanitized) + new user. Prior history: user, assistant(tool_calls),
    // tool, assistant(final).
    const messages = llmRequests[2]!.messages;
    expect(messages.map((m: any) => m.role)).toEqual([
      'system',          // system prompt
      'user',            // first user (from history)
      'assistant',       // assistant w/ tool_calls (from history)
      'tool',            // tool result (from history)
      'assistant',       // final answer from turn 1 (from history)
      'user',            // current user message
    ]);
    expect(messages[2].tool_calls).toBeDefined();
    expect(messages[3].tool_call_id).toBe('c1');
  });
});
