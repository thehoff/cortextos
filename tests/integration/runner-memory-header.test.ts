/**
 * PR2 (openai-compatible runtime): [memory: <thread-id>] header opt-in
 * conversational memory.
 *
 * Two AGENT MESSAGE blocks with the same [memory: <id>] header must:
 *
 *   (a) Cause the runner's first LLM call to include just system+user
 *       (no history yet).
 *   (b) Cause the runner's second LLM call to include the FIRST turn
 *       (user + assistant) as conversation history BEFORE the second user.
 *   (c) Append both turns to <stateDir>/threads/<id>.jsonl in order.
 *
 * This is the "Tokyo / its population" smoke test in PLAN.md's per-gate
 * validation matrix, lifted into a hermetic integration test.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { createServer, type Server } from 'http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { AddressInfo } from 'net';

const TSX_BIN = join(__dirname, '..', '..', 'node_modules', '.bin', 'tsx');
// Invoke through the main CLI entry so commander dispatches to the
// run-openai-agent subcommand and the action actually fires.
const CLI_SRC = join(__dirname, '..', '..', 'src', 'cli', 'index.ts');
const RUN_ARGS = [CLI_SRC, 'run-openai-agent'];

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

interface CompletionRequest {
  model: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
}

describe('PR2: runner [memory:] header → conversational history', { timeout: 30_000 }, () => {
  let tempRoot: string;
  let agentDir: string;
  let ctxRoot: string;
  let proc: ChildProcess | null = null;
  let mockServer: Server;
  let endpoint: string;
  let llmRequests: CompletionRequest[];
  let llmReplies: string[];

  beforeEach(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'pr2-memory-'));
    agentDir = join(tempRoot, 'project', 'orgs', 'acme', 'agents', 'rag-mem');
    ctxRoot = join(tempRoot, '.cortextos', 'memory-test');
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(ctxRoot, { recursive: true });
    llmRequests = [];
    llmReplies = ['Tokyo.', 'About 37 million.'];

    // Mock OpenAI-compatible /v1/chat/completions endpoint. Records every
    // incoming body and returns a canned answer in order.
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
        const content = llmReplies[idx] ?? '(no scripted reply)';
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content } }],
        }));
      });
    });

    await new Promise<void>(resolve => mockServer.listen(0, '127.0.0.1', () => resolve()));
    const port = (mockServer.address() as AddressInfo).port;
    endpoint = `http://127.0.0.1:${port}`;

    writeFileSync(join(agentDir, 'config.json'), JSON.stringify({
      agent_name: 'rag-mem',
      runtime: 'openai-compatible',
      enabled: true,
      endpoint,
      model: 'test-mem-model',
      heartbeat_interval_sec: 60,
      request_timeout_sec: 10,
    }));
    writeFileSync(join(agentDir, 'SYSTEM_PROMPT.md'), 'You are a geography assistant.');
  });

  afterEach(async () => {
    if (proc && !proc.killed) {
      proc.kill('SIGKILL');
      await new Promise<void>(resolve => proc!.once('exit', () => resolve()));
    }
    await new Promise<void>(resolve => mockServer.close(() => resolve()));
    // SIGKILL'd runner may have left in-flight atomic-write temp files in
    // its state dir. Give the kernel a moment to settle file handles, then
    // rm with retries to avoid ENOTEMPTY when the dir tree is large.
    await sleep(50);
    try {
      rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch { /* tmp cleanup is best-effort; OS will reap eventually */ }
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
          reject(new Error(`READY not seen within ${timeoutMs}ms. stdout so far:\n${buffer}`));
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

  async function waitForLlmCallCount(target: number, timeoutMs = 10_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (llmRequests.length >= target) return;
      await sleep(50);
    }
    throw new Error(`Expected ${target} LLM call(s); saw ${llmRequests.length} within ${timeoutMs}ms`);
  }

  it('two messages with the same [memory:] header build conversation history correctly', async () => {
    // Seed the sender's inbox dirs so checkInbox doesn't error when the
    // runner-side bus tries to pre-create them (it will via ensureDir).
    proc = spawn(TSX_BIN, RUN_ARGS, {
      env: {
        ...process.env,
        HOME: tempRoot,
        CTX_AGENT_NAME: 'rag-mem',
        CTX_AGENT_DIR: agentDir,
        CTX_ORG: 'acme',
        CTX_INSTANCE_ID: 'memory-test',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    await waitForReady(proc);

    // Send turn 1.
    proc.stdin!.write(buildMessage('human', 'mem-1', '[memory: tokyo-thread]\nWhat is the capital of Japan?'));
    await waitForLlmCallCount(1);
    // Wait a bit more for the runner to append to the thread file and ack.
    await sleep(200);

    // Send turn 2.
    proc.stdin!.write(buildMessage('human', 'mem-2', '[memory: tokyo-thread]\nAnd its population?'));
    await waitForLlmCallCount(2);
    await sleep(200);

    // First LLM request: system + user only, no history.
    const req1 = llmRequests[0];
    expect(req1.messages.map(m => m.role)).toEqual(['system', 'user']);
    expect(req1.messages[1].content).toMatch(/capital of Japan/);

    // Second LLM request: system + previous user + previous assistant +
    // new user. History is the load-bearing property.
    const req2 = llmRequests[1];
    expect(req2.messages.map(m => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(req2.messages[1].content).toMatch(/capital of Japan/);
    expect(req2.messages[2].content).toBe('Tokyo.');
    expect(req2.messages[3].content).toMatch(/population/);

    // Thread JSONL file should now have 2 user + 2 assistant entries, in order.
    const threadPath = join(ctxRoot, 'state', 'rag-mem', 'threads', 'tokyo-thread.jsonl');
    expect(existsSync(threadPath)).toBe(true);
    const lines = readFileSync(threadPath, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(4);
    const entries = lines.map(l => JSON.parse(l));
    expect(entries[0]).toEqual({ role: 'user', content: 'What is the capital of Japan?' });
    expect(entries[1]).toEqual({ role: 'assistant', content: 'Tokyo.' });
    expect(entries[2]).toEqual({ role: 'user', content: 'And its population?' });
    expect(entries[3]).toEqual({ role: 'assistant', content: 'About 37 million.' });
  });

  it('a message WITHOUT a [memory:] header is stateless — no thread file written', async () => {
    proc = spawn(TSX_BIN, RUN_ARGS, {
      env: {
        ...process.env,
        HOME: tempRoot,
        CTX_AGENT_NAME: 'rag-mem',
        CTX_AGENT_DIR: agentDir,
        CTX_ORG: 'acme',
        CTX_INSTANCE_ID: 'memory-test',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    await waitForReady(proc);

    proc.stdin!.write(buildMessage('human', 'no-mem-1', 'What is the capital of France?'));
    await waitForLlmCallCount(1);
    await sleep(200);

    // No [memory:] header → no thread file.
    const threadDir = join(ctxRoot, 'state', 'rag-mem', 'threads');
    if (existsSync(threadDir)) {
      // Directory may have been created speculatively elsewhere — confirm it's empty.
      const fs = require('fs');
      const files = fs.readdirSync(threadDir);
      expect(files).toHaveLength(0);
    }

    // The LLM call has no history.
    expect(llmRequests[0].messages.map(m => m.role)).toEqual(['system', 'user']);
  });
});
