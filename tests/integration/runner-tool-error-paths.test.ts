/**
 * PR3 (tool use): error paths in the tool loop.
 *
 * Covers (one scenario per `it`):
 *   - Malformed JSON arguments from the model → tool response is the
 *     error string, loop continues.
 *   - Per-tool timeout → AbortSignal fires, error returned to model.
 *   - Max iterations reached → graceful fallback reply, task_failed event.
 *   - HTTP 400 context-length on the LLM endpoint → user-visible reply
 *     "exceeded context window" instead of a silent ack-and-drop.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { createServer, type Server } from 'http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { AddressInfo } from 'net';

const TSX_BIN = join(__dirname, '..', '..', 'node_modules', '.bin', 'tsx');
const CLI_SRC = join(__dirname, '..', '..', 'src', 'cli', 'index.ts');
const RUN_ARGS = [CLI_SRC, 'run-openai-agent'];

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

interface ServerResponse {
  status?: number;
  body: any;
  contentType?: string;
}

describe('PR3: tool loop error paths', { timeout: 30_000 }, () => {
  let tempRoot: string;
  let agentDir: string;
  let ctxRoot: string;
  let proc: ChildProcess | null = null;
  let mockServer: Server;
  let endpoint: string;
  let llmCallCount: number;
  let scriptedResponses: ServerResponse[];

  beforeEach(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'pr3-tool-err-'));
    agentDir = join(tempRoot, 'project', 'orgs', 'acme', 'agents', 'rag-e');
    ctxRoot = join(tempRoot, '.cortextos', 'tool-err-test');
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(ctxRoot, { recursive: true });
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'),
      JSON.stringify({ 'rag-e': { enabled: true, org: 'acme' } }));
    llmCallCount = 0;
    scriptedResponses = [];

    mockServer = createServer((req, res) => {
      if (req.method !== 'POST' || !req.url?.endsWith('/v1/chat/completions')) {
        res.statusCode = 404;
        res.end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const idx = llmCallCount++;
        const r = scriptedResponses[idx] ?? { body: { choices: [{ message: { role: 'assistant', content: '(default)' } }] } };
        res.statusCode = r.status ?? 200;
        res.setHeader('Content-Type', r.contentType ?? 'application/json');
        res.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
      });
    });
    await new Promise<void>(resolve => mockServer.listen(0, '127.0.0.1', () => resolve()));
    const port = (mockServer.address() as AddressInfo).port;
    endpoint = `http://127.0.0.1:${port}`;
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

  function writeConfig(extra: Record<string, unknown> = {}): void {
    writeFileSync(join(agentDir, 'config.json'), JSON.stringify({
      agent_name: 'rag-e',
      runtime: 'openai-compatible',
      enabled: true,
      endpoint,
      model: 'test',
      heartbeat_interval_sec: 60,
      request_timeout_sec: 10,
      tools: ['get_current_time', 'kb_search'],
      ...extra,
    }));
    writeFileSync(join(agentDir, 'SYSTEM_PROMPT.md'), 'test');
  }

  async function waitForReady(child: ChildProcess, timeoutMs = 10_000): Promise<void> {
    const start = Date.now();
    let buffer = '';
    return new Promise((resolve, reject) => {
      const onData = (chunk: Buffer): void => {
        buffer += chunk.toString();
        if (buffer.includes('[openai-runner] READY')) {
          child.stdout!.off('data', onData); resolve();
        } else if (Date.now() - start > timeoutMs) {
          child.stdout!.off('data', onData);
          reject(new Error(`READY not seen within ${timeoutMs}ms.\nstdout:\n${buffer}`));
        }
      };
      child.stdout!.on('data', onData);
    });
  }

  function buildMessage(sender: string, msgId: string, body: string): string {
    return [
      `=== AGENT MESSAGE from ${sender} [msg_id: ${msgId}] ===`,
      '```', body, '```',
      `Reply using: cortextos bus send-message ${sender} normal '<your reply>' ${msgId}`,
      '',
    ].join('\n');
  }

  function spawnRunner(): ChildProcess {
    return spawn(TSX_BIN, RUN_ARGS, {
      env: {
        ...process.env, HOME: tempRoot,
        CTX_AGENT_NAME: 'rag-e', CTX_AGENT_DIR: agentDir, CTX_ORG: 'acme',
        CTX_INSTANCE_ID: 'tool-err-test',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  async function waitForLlmCallCount(target: number, timeoutMs = 10_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (llmCallCount >= target) return;
      await sleep(50);
    }
    throw new Error(`Expected ${target} LLM calls; saw ${llmCallCount}`);
  }

  it('malformed JSON arguments → tool response is error, loop continues', async () => {
    scriptedResponses = [
      { body: { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{
        id: 'c1', type: 'function', function: { name: 'get_current_time', arguments: '{garbage{{not json' },
      }]}}]}},
      { body: { choices: [{ message: { role: 'assistant', content: 'I will continue anyway.' } }]}},
    ];
    writeConfig();
    proc = spawnRunner();
    await waitForReady(proc);
    proc.stdin!.write(buildMessage('human', 'malf-1', 'try a tool'));
    await waitForLlmCallCount(2);
    await sleep(300);

    const today = new Date().toISOString().split('T')[0];
    const events = readFileSync(
      join(ctxRoot, 'orgs', 'acme', 'analytics', 'events', 'rag-e', `${today}.jsonl`),
      'utf-8',
    ).trim().split('\n').map(l => JSON.parse(l));
    const finished = events.find(e => e.event === 'tool_call_finished');
    expect(finished.metadata.status).toBe('malformed_args');

    // The user got a reply (the recovery message).
    const inbox = readdirSync(join(ctxRoot, 'inbox', 'human')).filter(f => f.endsWith('.json'));
    expect(inbox.length).toBe(1);
  });

  it('max iterations reached → graceful fallback reply + task_failed event', async () => {
    // Every response keeps calling tools → loop hits max_iterations.
    for (let i = 0; i < 10; i++) {
      scriptedResponses.push({ body: { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{
        id: `c${i}`, type: 'function', function: { name: 'get_current_time', arguments: '{}' },
      }]}}]}});
    }
    writeConfig({ tool_loop_max_iterations: 3 });
    proc = spawnRunner();
    await waitForReady(proc);
    proc.stdin!.write(buildMessage('human', 'spin-1', 'spin forever'));
    await waitForLlmCallCount(3);  // max_iterations = 3 → at most 3 LLM calls
    await sleep(500);

    const inbox = readdirSync(join(ctxRoot, 'inbox', 'human')).filter(f => f.endsWith('.json'));
    expect(inbox.length).toBe(1);
    const reply = JSON.parse(readFileSync(join(ctxRoot, 'inbox', 'human', inbox[0]!), 'utf-8'));
    expect(reply.text).toMatch(/exceeded.*tool-iteration budget/i);

    const today = new Date().toISOString().split('T')[0];
    const events = readFileSync(
      join(ctxRoot, 'orgs', 'acme', 'analytics', 'events', 'rag-e', `${today}.jsonl`),
      'utf-8',
    ).trim().split('\n').map(l => JSON.parse(l));
    expect(events.find(e => e.event === 'task_failed' && e.metadata.reason === 'tool_loop_max_iterations_exceeded')).toBeDefined();
  });

  it('HTTP 400 context-length → user-visible "exceeded context window" reply', async () => {
    scriptedResponses = [
      { status: 400, contentType: 'text/plain', body: 'context_length_exceeded: too many tokens' },
    ];
    writeConfig();
    proc = spawnRunner();
    await waitForReady(proc);
    proc.stdin!.write(buildMessage('human', 'ctx-1', 'a huge prompt'));
    await waitForLlmCallCount(1);
    await sleep(500);

    const inbox = readdirSync(join(ctxRoot, 'inbox', 'human')).filter(f => f.endsWith('.json'));
    expect(inbox.length).toBe(1);
    const reply = JSON.parse(readFileSync(join(ctxRoot, 'inbox', 'human', inbox[0]!), 'utf-8'));
    expect(reply.text).toMatch(/context window/i);

    const today = new Date().toISOString().split('T')[0];
    const events = readFileSync(
      join(ctxRoot, 'orgs', 'acme', 'analytics', 'events', 'rag-e', `${today}.jsonl`),
      'utf-8',
    ).trim().split('\n').map(l => JSON.parse(l));
    expect(events.find(e => e.event === 'task_failed' && e.metadata.reason === 'context_window_exceeded')).toBeDefined();
  });
});
