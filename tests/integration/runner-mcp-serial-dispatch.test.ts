/**
 * PR5 (MCP support) — serial dispatch integration test
 * (PLAN §18.2, Codex pass-1 PR5-012 + pass-3 PR5-023).
 *
 * Mock LLM emits TWO mcp__-prefixed tool_calls in a single assistant
 * message. The loop must await each result before starting the next, so
 * the log written by the fixture shows slow-start, slow-end, quick-start,
 * quick-end in that order (NOT slow-start, quick-start, ...).
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
const SERIAL_FIXTURE = join(REPO_ROOT, 'tests', 'fixtures', 'mcp', 'server-serial.ts');

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

describe('PR5 runner + MCP serial tool dispatch', { timeout: 30_000 }, () => {
  let tempRoot: string;
  let agentDir: string;
  let ctxRoot: string;
  let serialLog: string;
  let proc: ChildProcess | null = null;
  let mockLlm: Server;
  let endpoint: string;
  let llmTurns: number;

  beforeEach(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'pr5-serial-'));
    agentDir = join(tempRoot, 'project', 'orgs', 'acme', 'agents', 'rag');
    ctxRoot = join(tempRoot, '.cortextos', 'serial-test');
    serialLog = join(tempRoot, 'serial.log');
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'),
      JSON.stringify({ rag: { enabled: true, org: 'acme' } }));
    llmTurns = 0;

    mockLlm = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        llmTurns++;
        let body;
        if (llmTurns === 1) {
          // Turn 1: emit TWO tool calls in one assistant message.
          body = {
            choices: [{
              message: {
                role: 'assistant', content: null,
                tool_calls: [
                  { id: 'c1', type: 'function', function: { name: 'mcp__pair__slow', arguments: '{}' } },
                  { id: 'c2', type: 'function', function: { name: 'mcp__pair__quick', arguments: '{}' } },
                ],
              },
            }],
          };
        } else {
          body = { choices: [{ message: { role: 'assistant', content: 'both done' } }] };
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(body));
      });
    });
    await new Promise<void>(resolve => mockLlm.listen(0, '127.0.0.1', () => resolve()));
    const port = (mockLlm.address() as AddressInfo).port;
    endpoint = `http://127.0.0.1:${port}`;

    writeFileSync(join(agentDir, 'config.json'), JSON.stringify({
      agent_name: 'rag', runtime: 'openai-compatible', enabled: true,
      endpoint, model: 'test',
      heartbeat_interval_sec: 60, request_timeout_sec: 10,
      tools: ['mcp__pair__slow', 'mcp__pair__quick'],
      mcp_servers: [{
        name: 'pair', command: TSX_BIN, args: [SERIAL_FIXTURE],
        env: { MCP_SERIAL_LOG: serialLog },
      }],
      mcp_boot_timeout_sec: 15,
    }));
    writeFileSync(join(agentDir, 'SYSTEM_PROMPT.md'), 'You are a test agent.');
  });

  afterEach(async () => {
    if (proc && proc.exitCode === null && !proc.killed) {
      proc.kill('SIGKILL');
      await Promise.race([
        new Promise<void>(resolve => proc!.once('exit', () => resolve())),
        sleep(2000),
      ]);
    }
    await new Promise<void>(resolve => mockLlm.close(() => resolve()));
    await sleep(50);
    try { rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* */ }
  });

  it('awaits the first MCP tool_call before starting the second (serial dispatch)', async () => {
    proc = spawn(TSX_BIN, [CLI_SRC, 'run-openai-agent'], {
      env: {
        ...process.env, HOME: tempRoot,
        CTX_AGENT_NAME: 'rag', CTX_AGENT_DIR: agentDir,
        CTX_ORG: 'acme', CTX_INSTANCE_ID: 'serial-test',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    await new Promise<void>((resolve, reject) => {
      let buffer = '';
      const t = setTimeout(() => reject(new Error('READY timeout')), 20_000);
      proc!.stdout!.on('data', (c) => {
        buffer += c.toString();
        if (buffer.includes('[openai-runner] READY')) { clearTimeout(t); resolve(); }
      });
    });

    proc.stdin!.write([
      `=== AGENT MESSAGE from human [msg_id: m1] ===`,
      '```', 'run both', '```',
      `Reply using: cortextos bus send-message human normal '<your reply>' m1`, '',
    ].join('\n'));

    // Wait for reply or timeout.
    const inboxDir = join(ctxRoot, 'inbox', 'human');
    const start = Date.now();
    while (Date.now() - start < 25_000) {
      if (existsSync(inboxDir) && readdirSync(inboxDir).some(f => f.endsWith('.json'))) break;
      await sleep(100);
    }
    expect(existsSync(serialLog)).toBe(true);
    const lines = readFileSync(serialLog, 'utf-8').trim().split('\n').filter(Boolean);
    // Expected order: slow-start, slow-end, quick-start, quick-end.
    expect(lines.length).toBe(4);
    const tags = lines.map(l => l.split(' ')[1]);
    expect(tags).toEqual(['slow-start', 'slow-end', 'quick-start', 'quick-end']);
  });
});
