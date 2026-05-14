/**
 * PR5 (MCP support) — absent-`tools` integration test
 * (PLAN §8.2, Codex pass-2 PR5-014 + pass-3 PR5-030 verification).
 *
 * When `tools` is omitted entirely from config.json (vs the explicit
 * empty array which disables everything), the runner must advertise
 * BOTH the builtin tools AND any MCP-discovered tools to the LLM. This
 * test captures the mock-LLM POST body and asserts:
 *   - At least one builtin name (`get_current_time`) is in the tools[].
 *   - At least one MCP-discovered name (`mcp__demo__echo`) is in tools[].
 *
 * The original PR5-014 finding was that absent `tools` produced an
 * empty array; the fix in run-openai-agent.ts materializes ALL after
 * MCP boot. This test is the integration-level proof.
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
const ECHO_FIXTURE = join(REPO_ROOT, 'tests', 'fixtures', 'mcp', 'server-echo.ts');

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

describe('PR5 runner + MCP — absent `tools` enables builtins + MCP', { timeout: 30_000 }, () => {
  let tempRoot: string;
  let agentDir: string;
  let ctxRoot: string;
  let proc: ChildProcess | null = null;
  let mockLlm: Server;
  let endpoint: string;
  let lastRequestBody: string;

  beforeEach(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'pr5-toolsabsent-'));
    agentDir = join(tempRoot, 'project', 'orgs', 'acme', 'agents', 'rag');
    ctxRoot = join(tempRoot, '.cortextos', 'tools-absent-test');
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'),
      JSON.stringify({ rag: { enabled: true, org: 'acme' } }));
    lastRequestBody = '';

    mockLlm = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        lastRequestBody = Buffer.concat(chunks).toString('utf-8');
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'no tools used' } }] }));
      });
    });
    await new Promise<void>(resolve => mockLlm.listen(0, '127.0.0.1', () => resolve()));
    const port = (mockLlm.address() as AddressInfo).port;
    endpoint = `http://127.0.0.1:${port}`;

    // No `tools` key on purpose.
    writeFileSync(join(agentDir, 'config.json'), JSON.stringify({
      agent_name: 'rag', runtime: 'openai-compatible', enabled: true,
      endpoint, model: 'test',
      heartbeat_interval_sec: 60, request_timeout_sec: 10,
      mcp_servers: [{ name: 'demo', command: TSX_BIN, args: [ECHO_FIXTURE] }],
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

  it('advertises both builtin and MCP tools when config omits `tools`', async () => {
    proc = spawn(TSX_BIN, [CLI_SRC, 'run-openai-agent'], {
      env: {
        ...process.env, HOME: tempRoot,
        CTX_AGENT_NAME: 'rag', CTX_AGENT_DIR: agentDir,
        CTX_ORG: 'acme', CTX_INSTANCE_ID: 'tools-absent-test',
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
      '```', 'just say hi', '```',
      `Reply using: cortextos bus send-message human normal '<your reply>' m1`, '',
    ].join('\n'));

    const inboxDir = join(ctxRoot, 'inbox', 'human');
    const start = Date.now();
    while (Date.now() - start < 25_000) {
      if (existsSync(inboxDir) && readdirSync(inboxDir).some(f => f.endsWith('.json'))) break;
      await sleep(100);
    }

    expect(lastRequestBody).not.toBe('');
    const parsed = JSON.parse(lastRequestBody);
    const toolNames: string[] = Array.isArray(parsed.tools)
      ? parsed.tools.map((t: { function?: { name?: string } }) => t.function?.name).filter(Boolean)
      : [];
    expect(toolNames.length).toBeGreaterThan(1);
    // Builtin proof.
    expect(toolNames).toContain('get_current_time');
    // MCP discovery proof.
    expect(toolNames).toContain('mcp__demo__echo');
  });
});
