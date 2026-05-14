/**
 * PR5 (MCP support) — SIGTERM-during-boot integration test
 * (PLAN §18.2, Codex pass-1 PR5-002 + pass-3 PR5-023 verification,
 * tightened to PID-tracked under Codex pass-4 PR5-041).
 *
 * Boot the runner against a hang-with-PID-track fixture that writes its
 * PID synchronously on startup and never responds to `initialize`, with
 * a long mcp_boot_timeout_sec. Send SIGTERM well before boot would
 * naturally fail. Assert:
 *   - Runner exits within 6s of the signal (NOT after the boot timeout).
 *   - The hang subprocess (whose PID the fixture recorded before the
 *     SDK handshake even began) is no longer alive after the runner
 *     exits. This is the substantive PR5-024 anti-leak property — the
 *     prior `void closer().catch(...); process.exit(0)` form would have
 *     exited the runner cleanly but left the hang child alive past the
 *     parent.
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
const HANG_PID_FIXTURE = join(REPO_ROOT, 'tests', 'fixtures', 'mcp', 'server-hang-pid-track.ts');

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

describe('PR5 runner + MCP SIGTERM-during-boot', { timeout: 30_000 }, () => {
  let tempRoot: string;
  let agentDir: string;
  let pidFile: string;
  let proc: ChildProcess | null = null;
  let mockLlm: Server;

  beforeEach(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'pr5-sigint-boot-'));
    agentDir = join(tempRoot, 'project', 'orgs', 'acme', 'agents', 'rag');
    pidFile = join(tempRoot, 'hang.pid');
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(join(tempRoot, '.cortextos', 'sigint-test', 'config'), { recursive: true });
    writeFileSync(
      join(tempRoot, '.cortextos', 'sigint-test', 'config', 'enabled-agents.json'),
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
      // Long boot timeout so the signal handler is the thing that ends boot,
      // not a timeout. If the SIGTERM-during-boot path didn't tear down
      // children, the test would catch the leak via the PID check.
      mcp_servers: [{
        name: 'hang', command: TSX_BIN, args: [HANG_PID_FIXTURE],
        env: { MCP_PIDFILE: pidFile },
      }],
      mcp_boot_timeout_sec: 25,
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

  it('exits within 6s of SIGTERM even when boot is mid-flight', async () => {
    proc = spawn(TSX_BIN, [CLI_SRC, 'run-openai-agent'], {
      env: {
        ...process.env, HOME: tempRoot,
        CTX_AGENT_NAME: 'rag', CTX_AGENT_DIR: agentDir,
        CTX_ORG: 'acme', CTX_INSTANCE_ID: 'sigint-test',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderr = '';
    proc.stderr!.on('data', (c) => { stderr += c.toString(); });

    // Wait for the BOOT_BEGIN marker, then a short additional delay to
    // ensure the SDK has spawned the hang subprocess. This is what makes
    // the test deterministic — the prior "sleep 750ms" form races tsx's
    // startup latency.
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('did not see MCP_BOOT_BEGIN within 15s')), 15_000);
      const onData = (): void => {
        if (stderr.includes('[openai-runner] MCP_BOOT_BEGIN')) {
          clearTimeout(t);
          proc!.stderr!.off('data', onData);
          resolve();
        }
      };
      proc!.stderr!.on('data', onData);
      // In case data arrived before this listener attached.
      onData();
    });
    await sleep(250);
    // Poll for the PID file — the fixture writes it synchronously on
    // startup, but tsx-compile latency means we can't assume the wall-
    // clock window between MCP_BOOT_BEGIN and the SDK spawn-handshake
    // is enough. The fixture writes BEFORE any stdin read so once we
    // observe the file the boot is definitely mid-flight.
    {
      const pidWaitStart = Date.now();
      while (!existsSync(pidFile) && Date.now() - pidWaitStart < 5_000) {
        await sleep(50);
      }
      expect(existsSync(pidFile)).toBe(true);
    }
    const hangPid = Number(readFileSync(pidFile, 'utf-8'));
    expect(Number.isFinite(hangPid) && hangPid > 0).toBe(true);
    expect(isAlive(hangPid)).toBe(true);

    const signalStart = Date.now();
    proc.kill('SIGTERM');
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('runner did not exit within 6s of SIGTERM-during-boot')), 6_000);
      proc!.once('exit', () => { clearTimeout(t); resolve(); });
    });
    const exitElapsed = Date.now() - signalStart;

    // The KEY property tested: SIGTERM during mid-boot does NOT leak the
    // hang subprocess. Pre-PR5-024 the signal handler fired `void
    // closer().catch(...)` then `process.exit(0)` synchronously, so the
    // SDK's client.close() never finished and the hang child stayed
    // alive past the parent. Codex pass-4 PR5-041: only the PID check
    // catches that regression; the runner-exits-within-6s budget alone
    // is satisfied by both the broken AND the fixed forms.
    expect(exitElapsed).toBeLessThan(6_000);
    expect(stderr).toMatch(/\[openai-runner] sigterm/);

    // Allow the kernel time to reap the rolled-back child after the
    // runner exits. Under heavy vitest parallelism, init's reaping of
    // reparented zombies can drift past 1-2s.
    for (let i = 0; i < 100 && isAlive(hangPid); i++) await sleep(100);
    expect(isAlive(hangPid)).toBe(false);
  });
});
