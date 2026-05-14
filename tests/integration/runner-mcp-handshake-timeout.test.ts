/**
 * PR5 (MCP support) — handshake-timeout integration test
 * (PLAN §18.2, Codex pass-3 PR5-023).
 *
 * Boot the runner against a hang fixture with a short mcp_boot_timeout.
 * Assert the runner exits non-zero with a FATAL line that names the
 * server and includes "timed out".
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { createServer, type Server } from 'http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { AddressInfo } from 'net';

const REPO_ROOT = join(__dirname, '..', '..');
const TSX_BIN = join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const CLI_SRC = join(REPO_ROOT, 'src', 'cli', 'index.ts');
const HANG_FIXTURE = join(REPO_ROOT, 'tests', 'fixtures', 'mcp', 'server-hang.ts');

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

describe('PR5 runner + MCP handshake timeout', { timeout: 30_000 }, () => {
  let tempRoot: string;
  let agentDir: string;
  let proc: ChildProcess | null = null;
  let mockLlm: Server;

  beforeEach(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'pr5-handshake-'));
    agentDir = join(tempRoot, 'project', 'orgs', 'acme', 'agents', 'rag');
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(join(tempRoot, '.cortextos', 'handshake-test', 'config'), { recursive: true });
    writeFileSync(
      join(tempRoot, '.cortextos', 'handshake-test', 'config', 'enabled-agents.json'),
      JSON.stringify({ rag: { enabled: true, org: 'acme' } }),
    );

    mockLlm = createServer((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
    });
    await new Promise<void>(resolve => mockLlm.listen(0, '127.0.0.1', () => resolve()));
    const port = (mockLlm.address() as AddressInfo).port;

    writeFileSync(join(agentDir, 'config.json'), JSON.stringify({
      agent_name: 'rag', runtime: 'openai-compatible', enabled: true,
      endpoint: `http://127.0.0.1:${port}`, model: 'test',
      heartbeat_interval_sec: 60, request_timeout_sec: 10,
      mcp_servers: [{ name: 'hang', command: TSX_BIN, args: [HANG_FIXTURE] }],
      mcp_boot_timeout_sec: 2,
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

  it('exits with FATAL and a "timed out" message when the MCP server never responds to initialize', async () => {
    proc = spawn(TSX_BIN, [CLI_SRC, 'run-openai-agent'], {
      env: {
        ...process.env, HOME: tempRoot,
        CTX_AGENT_NAME: 'rag', CTX_AGENT_DIR: agentDir,
        CTX_ORG: 'acme', CTX_INSTANCE_ID: 'handshake-test',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    proc.stderr!.on('data', (c) => { stderr += c.toString(); });

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('runner did not exit within 10s')), 10_000);
      proc!.once('exit', (code) => { clearTimeout(t); resolve(code); });
    });

    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/FATAL: MCP boot failed/);
    expect(stderr).toMatch(/timed out/);
    // The server name should appear in the error so the operator knows
    // which MCP entry failed.
    expect(stderr).toMatch(/"hang"/);
  });
});
