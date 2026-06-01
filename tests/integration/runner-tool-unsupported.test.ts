/**
 * PR3 (tool use): graceful fallback when the LLM endpoint doesn't support
 * the `tools` parameter (Codex H3).
 *
 * If the first request with `tools` returns HTTP 400 whose body mentions
 * "tools", "function", or "unsupported", the runner caches
 * toolsSupported=false, logs a `tool_unsupported` event, and re-issues the
 * same call WITHOUT `tools`. The agent serves the message conversationally
 * and continues to do so for the rest of its process lifetime.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { createServer, type Server } from 'http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { AddressInfo } from 'net';

const TSX_BIN = join(__dirname, '..', '..', 'node_modules', '.bin', 'tsx');
const CLI_SRC = join(__dirname, '..', '..', 'src', 'cli', 'index.ts');
const RUN_ARGS = [CLI_SRC, 'run-openai-agent'];

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('PR3: tools-unsupported endpoint fallback', { timeout: 30_000 }, () => {
  let tempRoot: string;
  let agentDir: string;
  let ctxRoot: string;
  let proc: ChildProcess | null = null;
  let mockServer: Server;
  let endpoint: string;
  let llmRequests: any[];

  beforeEach(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'pr3-tool-unsup-'));
    agentDir = join(tempRoot, 'project', 'orgs', 'acme', 'agents', 'rag-u');
    ctxRoot = join(tempRoot, '.cortextos', 'tool-unsup-test');
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(ctxRoot, { recursive: true });
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'),
      JSON.stringify({ 'rag-u': { enabled: true, org: 'acme' } }));
    llmRequests = [];

    mockServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        llmRequests.push(body);
        // If the request has `tools`, reject with the documented signature
        // ("unsupported parameter: tools"). If it doesn't, return a normal
        // conversational answer.
        if (body.tools) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'text/plain');
          res.end('unsupported parameter: tools');
        } else {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Plain reply.' } }] }));
        }
      });
    });
    await new Promise<void>(resolve => mockServer.listen(0, '127.0.0.1', () => resolve()));
    const port = (mockServer.address() as AddressInfo).port;
    endpoint = `http://127.0.0.1:${port}`;

    writeFileSync(join(agentDir, 'config.json'), JSON.stringify({
      agent_name: 'rag-u',
      runtime: 'openai-compatible',
      enabled: true,
      endpoint,
      model: 'test',
      heartbeat_interval_sec: 60,
      request_timeout_sec: 10,
      tools: ['get_current_time'],
    }));
    writeFileSync(join(agentDir, 'SYSTEM_PROMPT.md'), 'test');
  });

  afterEach(async () => {
    if (proc && !proc.killed) {
      proc.kill('SIGKILL');
      await new Promise<void>(resolve => proc!.once('exit', () => resolve()));
    }
    await new Promise<void>(resolve => mockServer.close(() => resolve()));
    await sleep(50);
    try { rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* */ }
  });

  it('first call with tools → 400 → retries without tools → reply lands cleanly', async () => {
    proc = spawn(TSX_BIN, RUN_ARGS, {
      env: { ...process.env, HOME: tempRoot,
        CTX_AGENT_NAME: 'rag-u', CTX_AGENT_DIR: agentDir, CTX_ORG: 'acme',
        CTX_INSTANCE_ID: 'tool-unsup-test' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    await new Promise<void>((resolve, reject) => {
      let buffer = '';
      const t = setTimeout(() => reject(new Error('READY timeout')), 10_000);
      proc!.stdout!.on('data', (c) => {
        buffer += c.toString();
        if (buffer.includes('[openai-runner] READY')) {
          clearTimeout(t); resolve();
        }
      });
    });

    proc.stdin!.write([
      `=== AGENT MESSAGE from human [msg_id: u1] ===`,
      '```', 'hello', '```',
      `Reply using: cortextos bus send-message human normal '<your reply>' u1`, '',
    ].join('\n'));
    // Wait for at least 2 requests (the original with tools, the retry without).
    const start = Date.now();
    while (llmRequests.length < 2 && Date.now() - start < 10_000) {
      await sleep(50);
    }
    await sleep(300);

    expect(llmRequests.length).toBe(2);
    expect(llmRequests[0].tools).toBeDefined();
    expect(llmRequests[1].tools).toBeUndefined();

    // Codex P3-3: tool_unsupported event lands in the analytics stream once
    // the fallback fires — operator visibility.
    const today = new Date().toISOString().split('T')[0];
    const events = readFileSync(
      join(ctxRoot, 'orgs', 'acme', 'analytics', 'events', 'rag-u', `${today}.jsonl`),
      'utf-8',
    ).trim().split('\n').map(l => JSON.parse(l));
    const tooEvt = events.find(e => e.event === 'tool_unsupported');
    expect(tooEvt).toBeDefined();
    expect(tooEvt.category).toBe('action');
    expect(tooEvt.severity).toBe('warning');
    expect(tooEvt.metadata.reason).toBe('endpoint_rejected_tools_parameter');

    // Cache flag survives across messages: the next message's request also
    // omits `tools` (we don't retry the rejection every turn).
    proc.stdin!.write([
      `=== AGENT MESSAGE from human [msg_id: u2] ===`,
      '```', 'second message', '```',
      `Reply using: cortextos bus send-message human normal '<your reply>' u2`, '',
    ].join('\n'));
    const start2 = Date.now();
    while (llmRequests.length < 3 && Date.now() - start2 < 10_000) {
      await sleep(50);
    }
    expect(llmRequests[2].tools).toBeUndefined();

    // Reply landed in human's inbox.
    const inbox = readdirSync(join(ctxRoot, 'inbox', 'human')).filter(f => f.endsWith('.json'));
    expect(inbox.length).toBeGreaterThanOrEqual(1);
  });
});
