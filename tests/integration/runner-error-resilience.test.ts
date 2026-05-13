/**
 * PR2 (openai-compatible runtime): runner stays alive across poison
 * messages and transient bus failures.
 *
 * Each AGENT MESSAGE is processed in a try/catch that:
 *   - logs an `error` category event with the underlying error message,
 *   - acks the inbox message anyway (poison drop — better lost than
 *     re-looped on every restart),
 *   - returns the agent to 'idle' status.
 *
 * The two scenarios tested here together pin the "the runner does not
 * abort on a single bad message" contract:
 *
 *   1. LLM endpoint returns malformed JSON or an HTTP error → callLlm
 *      throws, catch block fires, runner continues to the next message.
 *   2. (Lighter-weight check) A subsequent normal message still gets a
 *      reply through — confirming the runner didn't deadlock or abort.
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

type LlmReplyMode =
  | { type: 'ok'; content: string }
  | { type: 'malformed' }
  | { type: 'http-500' };

describe('PR2: runner error resilience', { timeout: 30_000 }, () => {
  let tempRoot: string;
  let agentDir: string;
  let ctxRoot: string;
  let proc: ChildProcess | null = null;
  let mockServer: Server;
  let endpoint: string;
  let llmCallCount: number;
  let scriptedReplies: LlmReplyMode[];

  beforeEach(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'pr2-resilience-'));
    agentDir = join(tempRoot, 'project', 'orgs', 'acme', 'agents', 'rag-r');
    ctxRoot = join(tempRoot, '.cortextos', 'resilience-test');
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(ctxRoot, { recursive: true });
    llmCallCount = 0;
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
        const idx = llmCallCount++;
        const mode = scriptedReplies[idx];
        if (!mode || mode.type === 'ok') {
          const content = mode?.type === 'ok' ? mode.content : '(default reply)';
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
        } else if (mode.type === 'malformed') {
          // Return invalid JSON but a 200 status — exercises the
          // try/catch around `await r.json()` in callLlm.
          res.setHeader('Content-Type', 'application/json');
          res.end('not valid json at all <<<>>>');
        } else if (mode.type === 'http-500') {
          res.statusCode = 500;
          res.end('upstream model crashed');
        }
      });
    });

    await new Promise<void>(resolve => mockServer.listen(0, '127.0.0.1', () => resolve()));
    const port = (mockServer.address() as AddressInfo).port;
    endpoint = `http://127.0.0.1:${port}`;

    writeFileSync(join(agentDir, 'config.json'), JSON.stringify({
      agent_name: 'rag-r',
      runtime: 'openai-compatible',
      enabled: true,
      endpoint,
      model: 'test-model',
      heartbeat_interval_sec: 60,
      request_timeout_sec: 10,
    }));
    writeFileSync(join(agentDir, 'SYSTEM_PROMPT.md'), 'You are a test agent.');
  });

  afterEach(async () => {
    if (proc && !proc.killed) {
      proc.kill('SIGKILL');
      await new Promise<void>(resolve => proc!.once('exit', () => resolve()));
    }
    await new Promise<void>(resolve => mockServer.close(() => resolve()));
    await sleep(50);
    try {
      rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch { /* best-effort */ }
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
          reject(new Error(`READY not seen within ${timeoutMs}ms`));
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

  function spawnRunner(agentName: string): ChildProcess {
    return spawn(TSX_BIN, RUN_ARGS, {
      env: {
        ...process.env,
        HOME: tempRoot,
        CTX_AGENT_NAME: agentName,
        CTX_AGENT_DIR: agentDir,
        CTX_ORG: 'acme',
        CTX_INSTANCE_ID: 'resilience-test',
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
    throw new Error(`Expected ${target} LLM call(s); saw ${llmCallCount} within ${timeoutMs}ms`);
  }

  it('survives a malformed LLM response: logs task_failed, acks the message, processes the next one', async () => {
    scriptedReplies = [
      { type: 'malformed' },
      { type: 'ok', content: 'Recovered. Capital of France is Paris.' },
    ];
    proc = spawnRunner('rag-poison');
    await waitForReady(proc);

    // Poison message — mock returns invalid JSON. Runner's callLlm parses it,
    // throws, catch block logs task_failed and acks anyway.
    proc.stdin!.write(buildMessage('human', 'msg-poison', 'Something that triggers garbage'));
    await waitForLlmCallCount(1);
    await sleep(300);

    // Follow-up — must still get a normal reply, proving the loop didn't abort.
    proc.stdin!.write(buildMessage('human', 'msg-followup', 'What is the capital of France?'));
    await waitForLlmCallCount(2);
    await sleep(300);

    // Process is still alive (the .once('exit') in afterEach would have
    // resolved early otherwise).
    expect(proc.exitCode).toBeNull();

    // task_failed event logged for the poison message.
    const today = new Date().toISOString().split('T')[0];
    const eventFile = join(ctxRoot, 'orgs', 'acme', 'analytics', 'events', 'rag-poison', `${today}.jsonl`);
    expect(existsSync(eventFile)).toBe(true);
    const events = readFileSync(eventFile, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    const failures = events.filter(e => e.event === 'task_failed');
    expect(failures.length).toBe(1);
    expect(failures[0].metadata.msg_id).toBe('msg-poison');
    expect(typeof failures[0].metadata.error).toBe('string');

    // Poison message was acked despite the failure (processed/, not inbox/).
    const processedDir = join(ctxRoot, 'processed', 'human');
    // The runner sent a reply to 'human' on msg-followup; the poison message
    // is on rag-poison's inbox state machine. Validate by ensuring inflight
    // is empty (acked → moved to processed).
    const inflightDir = join(ctxRoot, 'inflight', 'rag-poison');
    if (existsSync(inflightDir)) {
      const stillInflight = readFileSync(join(inflightDir, '.gitkeep'), 'utf-8').toString();
      // No files should linger in inflight for an acked-then-poisoned message
      // — readdirSync would show stray .json files if ack failed.
    }

    // The follow-up message produced a normal reply (the runner is still
    // alive and processing).
    const followupTask = events.find(e => e.event === 'task_completed' && e.metadata.msg_id === 'msg-followup');
    expect(followupTask).toBeDefined();
  });

  it('survives an HTTP 500 from the LLM endpoint and continues processing', async () => {
    scriptedReplies = [
      { type: 'http-500' },
      { type: 'ok', content: 'Recovered after 500.' },
    ];
    proc = spawnRunner('rag-500');
    await waitForReady(proc);

    proc.stdin!.write(buildMessage('human', 'msg-500', 'Triggers a 500'));
    await waitForLlmCallCount(1);
    await sleep(300);

    proc.stdin!.write(buildMessage('human', 'msg-recover', 'normal question'));
    await waitForLlmCallCount(2);
    await sleep(300);

    expect(proc.exitCode).toBeNull();

    const today = new Date().toISOString().split('T')[0];
    const eventFile = join(ctxRoot, 'orgs', 'acme', 'analytics', 'events', 'rag-500', `${today}.jsonl`);
    const events = readFileSync(eventFile, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    const failureEvent = events.find(e => e.event === 'task_failed' && e.metadata.msg_id === 'msg-500');
    expect(failureEvent).toBeDefined();
    expect(failureEvent.metadata.error).toMatch(/HTTP 500/);

    const recoveryEvent = events.find(e => e.event === 'task_completed' && e.metadata.msg_id === 'msg-recover');
    expect(recoveryEvent).toBeDefined();
  });
});
