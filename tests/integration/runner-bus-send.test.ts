/**
 * PR3 (tool use): bus_send_message budget + recipient validation in the
 * full runner context.
 *
 * Unit tests cover the tool in isolation; this exercises the live runner
 * with a model that wants to call bus_send_message and confirms:
 *   - Budget enforcement: 4 calls in one model turn → only 3 sends.
 *   - Missing-recipient validation: send to a non-enabled agent → no
 *     message written, model gets an error.
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

describe('PR3: bus_send_message budget + recipient validation', { timeout: 30_000 }, () => {
  let tempRoot: string;
  let agentDir: string;
  let ctxRoot: string;
  let proc: ChildProcess | null = null;
  let mockServer: Server;
  let endpoint: string;
  let llmRequests: any[];
  let scriptedResponses: any[];

  beforeEach(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'pr3-bus-send-'));
    agentDir = join(tempRoot, 'project', 'orgs', 'acme', 'agents', 'rag-b');
    ctxRoot = join(tempRoot, '.cortextos', 'bus-send-test');
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(ctxRoot, { recursive: true });
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    // rag-b can send to specialist-1 and specialist-2; not to ghost-agent.
    writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), JSON.stringify({
      'rag-b': { enabled: true, org: 'acme' },
      'specialist-1': { enabled: true, org: 'acme' },
      'specialist-2': { enabled: true, org: 'acme' },
    }));
    llmRequests = [];
    scriptedResponses = [];

    mockServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        llmRequests.push(body);
        const idx = llmRequests.length - 1;
        const r = scriptedResponses[idx];
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(r ?? { choices: [{ message: { role: 'assistant', content: 'done' } }] }));
      });
    });
    await new Promise<void>(resolve => mockServer.listen(0, '127.0.0.1', () => resolve()));
    const port = (mockServer.address() as AddressInfo).port;
    endpoint = `http://127.0.0.1:${port}`;

    writeFileSync(join(agentDir, 'config.json'), JSON.stringify({
      agent_name: 'rag-b',
      runtime: 'openai-compatible',
      enabled: true,
      endpoint,
      model: 'test',
      heartbeat_interval_sec: 60,
      request_timeout_sec: 10,
      tools: ['bus_send_message'],
      tool_bus_send_budget: 3,
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

  function spawnRunner(): ChildProcess {
    return spawn(TSX_BIN, RUN_ARGS, {
      env: { ...process.env, HOME: tempRoot,
        CTX_AGENT_NAME: 'rag-b', CTX_AGENT_DIR: agentDir, CTX_ORG: 'acme',
        CTX_INSTANCE_ID: 'bus-send-test' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  async function waitForReady(child: ChildProcess): Promise<void> {
    let buffer = '';
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('READY timeout')), 10_000);
      child.stdout!.on('data', (c) => {
        buffer += c.toString();
        if (buffer.includes('[openai-runner] READY')) { clearTimeout(t); resolve(); }
      });
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

  async function waitForLlmCount(target: number): Promise<void> {
    const start = Date.now();
    while (llmRequests.length < target && Date.now() - start < 10_000) {
      await sleep(50);
    }
  }

  it('bus_send_message budget — 4 calls scripted, only 3 sends land', async () => {
    // Turn 1: model wants to delegate to specialist-1, specialist-2,
    // specialist-1 again, and specialist-2 again (4 calls in ONE assistant
    // turn). The 4th should hit the budget exhausted error.
    scriptedResponses = [
      { choices: [{ message: { role: 'assistant', content: null, tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'bus_send_message', arguments: JSON.stringify({ to: 'specialist-1', text: 'q1' }) } },
        { id: 'c2', type: 'function', function: { name: 'bus_send_message', arguments: JSON.stringify({ to: 'specialist-2', text: 'q2' }) } },
        { id: 'c3', type: 'function', function: { name: 'bus_send_message', arguments: JSON.stringify({ to: 'specialist-1', text: 'q3' }) } },
        { id: 'c4', type: 'function', function: { name: 'bus_send_message', arguments: JSON.stringify({ to: 'specialist-2', text: 'q4' }) } },
      ]}}]},
      { choices: [{ message: { role: 'assistant', content: 'Delegations done.' } }]},
    ];
    proc = spawnRunner();
    await waitForReady(proc);
    proc.stdin!.write(buildMessage('human', 'b1', 'delegate to all four'));
    await waitForLlmCount(2);
    await sleep(300);

    // specialist-1 should have 2 messages, specialist-2 should have 1
    // (because the 4th call hit the budget = 3 exhausted error).
    const s1Inbox = readdirSync(join(ctxRoot, 'inbox', 'specialist-1')).filter(f => f.endsWith('.json'));
    const s2Inbox = readdirSync(join(ctxRoot, 'inbox', 'specialist-2')).filter(f => f.endsWith('.json'));
    expect(s1Inbox.length + s2Inbox.length).toBe(3); // budget = 3 successful sends

    // The 2nd LLM request's messages contain a tool response with "budget exhausted".
    const toolResponses = llmRequests[1]!.messages.filter((m: any) => m.role === 'tool');
    expect(toolResponses.length).toBe(4);
    expect(toolResponses[3].content).toMatch(/budget exhausted/);
  });

  it('bus_send_message to a non-enabled recipient → error response, no inbox file', async () => {
    scriptedResponses = [
      { choices: [{ message: { role: 'assistant', content: null, tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'bus_send_message', arguments: JSON.stringify({ to: 'ghost-agent', text: 'are you there' }) } },
      ]}}]},
      { choices: [{ message: { role: 'assistant', content: 'They were not.' } }]},
    ];
    proc = spawnRunner();
    await waitForReady(proc);
    proc.stdin!.write(buildMessage('human', 'g1', 'try ghost'));
    await waitForLlmCount(2);
    await sleep(300);

    // No inbox file should exist for ghost-agent.
    let ghostFiles: string[] = [];
    try {
      ghostFiles = readdirSync(join(ctxRoot, 'inbox', 'ghost-agent'));
    } catch { /* dir may not exist — also fine */ }
    expect(ghostFiles.filter(f => f.endsWith('.json'))).toEqual([]);

    // Tool response on the second call says not enabled.
    const toolMessages = llmRequests[1]!.messages.filter((m: any) => m.role === 'tool');
    expect(toolMessages[0]!.content).toMatch(/not enabled/);
  });
});
