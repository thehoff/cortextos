/**
 * PR3 (tool use): regression — when no tools are enabled in config.json,
 * the runner sends NO `tools` field in the LLM request, preserving PR2
 * behaviour byte-for-byte (modulo the tools_supported cache flag which
 * is internal).
 *
 * This is the critical guard against the PR3 work changing the wire
 * shape for agents that didn't opt in.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { createServer, type Server } from 'http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { AddressInfo } from 'net';

const TSX_BIN = join(__dirname, '..', '..', 'node_modules', '.bin', 'tsx');
const CLI_SRC = join(__dirname, '..', '..', 'src', 'cli', 'index.ts');
const RUN_ARGS = [CLI_SRC, 'run-openai-agent'];

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('PR3: no-tools regression', { timeout: 30_000 }, () => {
  let tempRoot: string;
  let agentDir: string;
  let proc: ChildProcess | null = null;
  let mockServer: Server;
  let endpoint: string;
  let llmRequests: any[];

  beforeEach(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'pr3-no-tools-'));
    agentDir = join(tempRoot, 'project', 'orgs', 'acme', 'agents', 'rag-n');
    const ctxRoot = join(tempRoot, '.cortextos', 'no-tools-test');
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(ctxRoot, { recursive: true });
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'),
      JSON.stringify({ 'rag-n': { enabled: true, org: 'acme' } }));
    llmRequests = [];

    mockServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        llmRequests.push(body);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'PR2-style reply.' } }] }));
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
    try { rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* */ }
  });

  it('omits "tools" from the request entirely when config has no tools list', async () => {
    // No `tools` field in config.json at all.
    writeFileSync(join(agentDir, 'config.json'), JSON.stringify({
      agent_name: 'rag-n',
      runtime: 'openai-compatible',
      enabled: true,
      endpoint,
      model: 'test',
      heartbeat_interval_sec: 60,
      request_timeout_sec: 10,
    }));
    writeFileSync(join(agentDir, 'SYSTEM_PROMPT.md'), 'test');

    proc = spawn(TSX_BIN, RUN_ARGS, {
      env: { ...process.env, HOME: tempRoot,
        CTX_AGENT_NAME: 'rag-n', CTX_AGENT_DIR: agentDir, CTX_ORG: 'acme',
        CTX_INSTANCE_ID: 'no-tools-test' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    await new Promise<void>((resolve, reject) => {
      let buffer = '';
      const t = setTimeout(() => reject(new Error('READY timeout')), 10_000);
      proc!.stdout!.on('data', (c) => {
        buffer += c.toString();
        if (buffer.includes('[openai-runner] READY')) { clearTimeout(t); resolve(); }
      });
    });

    proc.stdin!.write([
      `=== AGENT MESSAGE from human [msg_id: n1] ===`,
      '```', 'hello', '```',
      `Reply using: cortextos bus send-message human normal '<your reply>' n1`, '',
    ].join('\n'));
    const start = Date.now();
    while (llmRequests.length < 1 && Date.now() - start < 10_000) await sleep(50);

    expect(llmRequests[0]).toBeDefined();
    expect(llmRequests[0]!.tools).toBeUndefined();
    expect(llmRequests[0]!.model).toBe('test');
    // PR2's wire shape preserved exactly — system + user.
    expect(llmRequests[0]!.messages.map((m: any) => m.role)).toEqual(['system', 'user']);
  });

  it('also omits "tools" when the tools array is explicitly empty', async () => {
    writeFileSync(join(agentDir, 'config.json'), JSON.stringify({
      agent_name: 'rag-n',
      runtime: 'openai-compatible',
      enabled: true,
      endpoint,
      model: 'test',
      heartbeat_interval_sec: 60,
      request_timeout_sec: 10,
      tools: [],
    }));
    writeFileSync(join(agentDir, 'SYSTEM_PROMPT.md'), 'test');

    proc = spawn(TSX_BIN, RUN_ARGS, {
      env: { ...process.env, HOME: tempRoot,
        CTX_AGENT_NAME: 'rag-n', CTX_AGENT_DIR: agentDir, CTX_ORG: 'acme',
        CTX_INSTANCE_ID: 'no-tools-test' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    await new Promise<void>((resolve, reject) => {
      let buffer = '';
      const t = setTimeout(() => reject(new Error('READY timeout')), 10_000);
      proc!.stdout!.on('data', (c) => {
        buffer += c.toString();
        if (buffer.includes('[openai-runner] READY')) { clearTimeout(t); resolve(); }
      });
    });

    proc.stdin!.write([
      `=== AGENT MESSAGE from human [msg_id: n2] ===`,
      '```', 'hello again', '```',
      `Reply using: cortextos bus send-message human normal '<your reply>' n2`, '',
    ].join('\n'));
    const start = Date.now();
    while (llmRequests.length < 1 && Date.now() - start < 10_000) await sleep(50);

    expect(llmRequests[0]).toBeDefined();
    expect(llmRequests[0]!.tools).toBeUndefined();
  });
});
