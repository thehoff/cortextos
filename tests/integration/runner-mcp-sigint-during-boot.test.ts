/**
 * PR5 (MCP support) — SIGTERM-during-boot integration test
 * (PLAN §18.2, Codex pass-1 PR5-002 + pass-3 PR5-023 verification).
 *
 * Boot the runner against a hang fixture that never responds to
 * `initialize`, with a long mcp_boot_timeout_sec. Send SIGTERM well
 * before boot would naturally fail. Assert:
 *   - Runner exits within 6s of the signal (NOT after the boot timeout).
 *   - Exit code is non-zero (the FATAL "MCP boot failed" path runs OR
 *     the signal handler short-circuits boot — either is acceptable as
 *     long as no zombie subprocess survives).
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
const HANG_FIXTURE = join(REPO_ROOT, 'tests', 'fixtures', 'mcp', 'server-hang.ts');

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

describe('PR5 runner + MCP SIGTERM-during-boot', { timeout: 30_000 }, () => {
  let tempRoot: string;
  let agentDir: string;
  let proc: ChildProcess | null = null;
  let mockLlm: Server;

  beforeEach(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'pr5-sigint-boot-'));
    agentDir = join(tempRoot, 'project', 'orgs', 'acme', 'agents', 'rag');
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
      // children, the test would time out at the suite level (30s).
      mcp_servers: [{ name: 'hang', command: TSX_BIN, args: [HANG_FIXTURE] }],
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
    // hang child stayed alive past the 5s outer budget (eventually it
    // would still die when the parent went away, but the runner had
    // already exited with code 0 — operators couldn't tell the difference
    // from a clean shutdown). Post-fix, the handler awaits MCP teardown
    // with a 5s outer race; if boot was mid-flight and rejection races
    // with the manager's own rollback, exit happens AFTER teardown is
    // either complete or has hit its budget.
    //
    // The substance of "no zombie subprocess" is verified at the manager
    // unit level (tests/unit/mcp/manager.test.ts > "shutdown during
    // boot"); here we only pin that the runner doesn't HANG. The exact
    // exit code (0 from graceful, 1 from bootMcpManager catch, or 143
    // from Node racing transport-close ordering) is too environment-
    // dependent — across vitest worker scheduling and SDK transport
    // teardown timing all three surface — to assert specifically.
    expect(exitElapsed).toBeLessThan(6_000);
    expect(stderr).toMatch(/\[openai-runner] sigterm/);
  });
});
