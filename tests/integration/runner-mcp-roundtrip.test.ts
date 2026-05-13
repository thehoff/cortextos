/**
 * PR5 (MCP support): end-to-end integration test.
 *
 * Spawns the runner with an MCP server in config.json, drives one inbox
 * message through it, and checks that:
 *   - The agent boots through MCP startup without timeout.
 *   - When the (mock) LLM responds with an mcp__-prefixed tool_call,
 *     the runner dispatches it to the MCP server and feeds the text
 *     result back into the next turn.
 *   - The agent_online event records the MCP servers + tool count.
 *
 * Uses the echo fixture under tests/fixtures/mcp/server-echo.ts and a
 * scripted mock LLM that emits a tool_call on turn 1, then a content
 * reply on turn 2 incorporating the tool result.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { createServer, type Server } from 'http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { AddressInfo } from 'net';

const REPO_ROOT = join(__dirname, '..', '..');
const TSX_BIN = join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const CLI_SRC = join(REPO_ROOT, 'src', 'cli', 'index.ts');
const RUN_ARGS = [CLI_SRC, 'run-openai-agent'];
const ECHO_FIXTURE = join(REPO_ROOT, 'tests', 'fixtures', 'mcp', 'server-echo.ts');

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

describe('PR5 runner + MCP roundtrip', { timeout: 30_000 }, () => {
  let tempRoot: string;
  let agentDir: string;
  let ctxRoot: string;
  let proc: ChildProcess | null = null;
  let mockLlm: Server;
  let endpoint: string;
  let llmTurns: number;

  beforeEach(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'pr5-mcp-'));
    agentDir = join(tempRoot, 'project', 'orgs', 'acme', 'agents', 'rag-m');
    ctxRoot = join(tempRoot, '.cortextos', 'mcp-test');
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(ctxRoot, { recursive: true });
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'),
      JSON.stringify({ 'rag-m': { enabled: true, org: 'acme' } }));
    llmTurns = 0;

    mockLlm = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        llmTurns++;
        let body;
        if (llmTurns === 1) {
          // Turn 1: emit a tool_call for mcp__demo__echo with a known text.
          body = {
            choices: [{
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [{
                  id: 'call-1', type: 'function',
                  function: { name: 'mcp__demo__echo', arguments: JSON.stringify({ text: 'roundtrip-ok' }) },
                }],
              },
            }],
          };
        } else {
          // Turn 2: content reply that names the tool result.
          body = {
            choices: [{
              message: { role: 'assistant', content: 'The MCP tool said roundtrip-ok.' },
            }],
          };
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(body));
      });
    });
    await new Promise<void>(resolve => mockLlm.listen(0, '127.0.0.1', () => resolve()));
    const port = (mockLlm.address() as AddressInfo).port;
    endpoint = `http://127.0.0.1:${port}`;

    writeFileSync(join(agentDir, 'config.json'), JSON.stringify({
      agent_name: 'rag-m',
      runtime: 'openai-compatible',
      enabled: true,
      endpoint,
      model: 'test',
      heartbeat_interval_sec: 60,
      request_timeout_sec: 10,
      tools: ['mcp__demo__echo'],
      mcp_servers: [
        { name: 'demo', command: TSX_BIN, args: [ECHO_FIXTURE] },
      ],
      mcp_boot_timeout_sec: 15,
    }));
    writeFileSync(join(agentDir, 'SYSTEM_PROMPT.md'), 'You are a test agent.');
  });

  afterEach(async () => {
    if (proc && proc.exitCode === null && !proc.killed) {
      proc.kill('SIGKILL');
      await Promise.race([
        new Promise<void>(resolve => proc!.once('exit', () => resolve())),
        sleep(3000),
      ]);
    }
    await new Promise<void>(resolve => mockLlm.close(() => resolve()));
    await sleep(50);
    try { rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* */ }
  });

  it('boots with an MCP server and round-trips a tool_call → tool result → final reply', async () => {
    proc = spawn(TSX_BIN, RUN_ARGS, {
      env: {
        ...process.env,
        HOME: tempRoot,
        CTX_AGENT_NAME: 'rag-m',
        CTX_AGENT_DIR: agentDir,
        CTX_ORG: 'acme',
        CTX_INSTANCE_ID: 'mcp-test',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    await new Promise<void>((resolve, reject) => {
      let buffer = '';
      const t = setTimeout(() => reject(new Error('READY timeout')), 20_000);
      proc!.stdout!.on('data', (c) => {
        buffer += c.toString();
        if (buffer.includes('[openai-runner] READY')) {
          clearTimeout(t); resolve();
        }
      });
    });

    proc.stdin!.write([
      `=== AGENT MESSAGE from human [msg_id: m1] ===`,
      '```', 'echo something for me', '```',
      `Reply using: cortextos bus send-message human normal '<your reply>' m1`, '',
    ].join('\n'));

    // Wait for human's inbox to receive a reply.
    const inboxDir = join(ctxRoot, 'inbox', 'human');
    const start = Date.now();
    while (Date.now() - start < 25_000) {
      if (existsSync(inboxDir) && readdirSync(inboxDir).some(f => f.endsWith('.json'))) {
        break;
      }
      await sleep(100);
    }
    const files = readdirSync(inboxDir).filter(f => f.endsWith('.json'));
    expect(files.length).toBeGreaterThanOrEqual(1);
    const reply = JSON.parse(readFileSync(join(inboxDir, files[0]!), 'utf-8'));
    expect(reply.text).toContain('roundtrip-ok');
    expect(llmTurns).toBeGreaterThanOrEqual(2);

    // agent_online event lists the MCP server.
    const today = new Date().toISOString().split('T')[0];
    const eventsPath = join(ctxRoot, 'orgs', 'acme', 'analytics', 'events', 'rag-m', `${today}.jsonl`);
    const events = readFileSync(eventsPath, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    const onlineEvt = events.find((e: any) => e.event === 'agent_online');
    expect(onlineEvt).toBeDefined();
    expect(onlineEvt.metadata.mcp_servers).toEqual(['demo']);
    expect(onlineEvt.metadata.mcp_tools_count).toBe(2);
  });
});
