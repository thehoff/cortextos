/**
 * PR5 (MCP support) — SIGTERM shutdown integration test (PLAN §18.2,
 * Codex pass-3 PR5-023 + PR5-024 verification).
 *
 * After the runner reaches READY with an MCP server attached, send
 * SIGTERM. Assert:
 *   - The runner exits cleanly (code 0) within 6s.
 *   - The MCP subprocess (whose PID the fixture wrote to a file at
 *     startup) is no longer alive after the runner exits.
 *
 * The 6s ceiling guards against a regression of the PR5-024 BLOCKER
 * fix where the SIGTERM handler used `void closer().catch(...)` and
 * called `process.exit(0)` synchronously, leaking the child.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { createServer, type Server } from 'http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { AddressInfo } from 'net';

const REPO_ROOT = join(__dirname, '..', '..');
const TSX_BIN = join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const CLI_SRC = join(REPO_ROOT, 'src', 'cli', 'index.ts');
const PID_FIXTURE = join(REPO_ROOT, 'tests', 'fixtures', 'mcp', 'server-pid-track.ts');

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('PR5 runner + MCP SIGTERM shutdown', { timeout: 30_000 }, () => {
  let tempRoot: string;
  let agentDir: string;
  let proc: ChildProcess | null = null;
  let mockLlm: Server;
  let pidFile: string;

  beforeEach(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'pr5-shutdown-'));
    agentDir = join(tempRoot, 'project', 'orgs', 'acme', 'agents', 'rag');
    pidFile = join(tempRoot, 'mcp.pid');
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(join(tempRoot, '.cortextos', 'shutdown-test', 'config'), { recursive: true });
    writeFileSync(
      join(tempRoot, '.cortextos', 'shutdown-test', 'config', 'enabled-agents.json'),
      JSON.stringify({ rag: { enabled: true, org: 'acme' } }),
    );

    mockLlm = createServer((_req, res) => {
      // No inbox messages in this test, but the server has to exist so
      // the runner can boot without complaining about a refused endpoint.
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
    });
    await new Promise<void>(resolve => mockLlm.listen(0, '127.0.0.1', () => resolve()));
    const port = (mockLlm.address() as AddressInfo).port;

    writeFileSync(join(agentDir, 'config.json'), JSON.stringify({
      agent_name: 'rag', runtime: 'openai-compatible', enabled: true,
      endpoint: `http://127.0.0.1:${port}`, model: 'test',
      heartbeat_interval_sec: 60, request_timeout_sec: 10,
      tools: ['mcp__demo__echo'],
      mcp_servers: [{ name: 'demo', command: TSX_BIN, args: [PID_FIXTURE], env: { MCP_PIDFILE: pidFile } }],
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

  it('exits cleanly within 6s on SIGTERM and reaps the MCP subprocess', async () => {
    proc = spawn(TSX_BIN, [CLI_SRC, 'run-openai-agent'], {
      env: {
        ...process.env, HOME: tempRoot,
        CTX_AGENT_NAME: 'rag', CTX_AGENT_DIR: agentDir,
        CTX_ORG: 'acme', CTX_INSTANCE_ID: 'shutdown-test',
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

    // The fixture wrote its PID before the SDK handshake.
    expect(existsSync(pidFile)).toBe(true);
    const mcpPid = Number(readFileSync(pidFile, 'utf-8'));
    expect(Number.isFinite(mcpPid) && mcpPid > 0).toBe(true);
    expect(isAlive(mcpPid)).toBe(true);

    const exitStart = Date.now();
    proc.kill('SIGTERM');
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('runner did not exit within 6s of SIGTERM')), 6_000);
      proc!.once('exit', (code) => { clearTimeout(t); resolve(code); });
    });
    const exitElapsed = Date.now() - exitStart;

    expect(exitCode).toBe(0);
    expect(exitElapsed).toBeLessThan(6_000);

    // Give the OS a beat to reap the child.
    for (let i = 0; i < 30 && isAlive(mcpPid); i++) await sleep(100);
    expect(isAlive(mcpPid)).toBe(false);
  });
});
