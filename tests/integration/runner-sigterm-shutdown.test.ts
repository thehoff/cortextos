/**
 * PR2 (openai-compatible runtime): SIGTERM shutdown sequence of the runner.
 *
 * AgentProcess.stop() for openai-compatible sends SIGTERM via
 * OpenAICompatiblePTY.signalShutdown() and waits 5s. The runner traps
 * SIGTERM and:
 *
 *   (a) flips heartbeat to status='stopping'
 *   (b) emits a milestone:agent_offline event
 *   (c) calls process.exit(0)
 *
 * This test spawns the actual runner via tsx, signals it, and asserts the
 * three side effects are visible on disk after exit. Without this, a quiet
 * regression in the SIGTERM handler could let agents disappear from the
 * dashboard with no `stopping` breadcrumb and no `agent_offline` analytics
 * event.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TSX_BIN = join(__dirname, '..', '..', 'node_modules', '.bin', 'tsx');
// Invoke through the main CLI entry (which dispatches to the
// run-openai-agent subcommand) so commander's parseAsync actually fires the
// action. Running the runner file directly only constructs the Command and
// exits — the action never runs.
const CLI_SRC = join(__dirname, '..', '..', 'src', 'cli', 'index.ts');
const RUN_ARGS = [CLI_SRC, 'run-openai-agent'];

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('PR2: runner SIGTERM shutdown sequence', { timeout: 30_000 }, () => {
  let tempRoot: string;
  let agentDir: string;
  let ctxRoot: string;
  let proc: ChildProcess | null = null;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'pr2-sigterm-'));
    agentDir = join(tempRoot, 'project', 'orgs', 'acme', 'agents', 'rag-1');
    ctxRoot = join(tempRoot, '.cortextos', 'sigterm-test');
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(ctxRoot, { recursive: true });

    writeFileSync(join(agentDir, 'config.json'), JSON.stringify({
      agent_name: 'rag-1',
      runtime: 'openai-compatible',
      enabled: true,
      endpoint: 'http://localhost:9',  // unreachable — runner doesn't need to call it for SIGTERM test
      model: 'test-model',
      heartbeat_interval_sec: 60,
    }));
    writeFileSync(join(agentDir, 'SYSTEM_PROMPT.md'), 'You are a test agent.\n');
  });

  afterEach(async () => {
    if (proc && !proc.killed) {
      proc.kill('SIGKILL');
      await new Promise<void>(resolve => proc!.once('exit', () => resolve()));
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  async function waitForReady(child: ChildProcess, timeoutMs = 10_000): Promise<void> {
    const start = Date.now();
    let buffer = '';
    return new Promise((resolve, reject) => {
      const onData = (chunk: Buffer): void => {
        buffer += chunk.toString();
        if (buffer.includes('[openai-runner] READY')) {
          child.stdout!.off('data', onData);
          resolve();
        } else if (Date.now() - start > timeoutMs) {
          child.stdout!.off('data', onData);
          reject(new Error(`READY not seen within ${timeoutMs}ms. stdout so far:\n${buffer}`));
        }
      };
      child.stdout!.on('data', onData);
    });
  }

  it('writes status=stopping to heartbeat.json after SIGTERM', async () => {
    proc = spawn(TSX_BIN, RUN_ARGS, {
      env: {
        ...process.env,
        HOME: tempRoot,  // resolvePaths uses homedir() — redirect
        CTX_AGENT_NAME: 'rag-1',
        CTX_AGENT_DIR: agentDir,
        CTX_ORG: 'acme',
        CTX_INSTANCE_ID: 'sigterm-test',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    await waitForReady(proc);

    // Send SIGTERM and wait for the process to exit (the runner's shutdown
    // handler runs sync, then process.exit(0)).
    const exitCode = await new Promise<number | null>((resolve) => {
      proc!.once('exit', (code) => resolve(code));
      proc!.kill('SIGTERM');
    });

    // Clean exit code expected (the runner calls process.exit(0) after
    // logging agent_offline + writing the 'stopping' heartbeat).
    expect(exitCode).toBe(0);

    const heartbeatPath = join(ctxRoot, 'state', 'rag-1', 'heartbeat.json');
    expect(existsSync(heartbeatPath)).toBe(true);
    const hb = JSON.parse(readFileSync(heartbeatPath, 'utf-8'));
    expect(hb.status).toBe('stopping');
    expect(hb.agent).toBe('rag-1');
  });

  it('emits an agent_offline milestone event before exiting', async () => {
    proc = spawn(TSX_BIN, RUN_ARGS, {
      env: {
        ...process.env,
        HOME: tempRoot,
        CTX_AGENT_NAME: 'rag-evt',
        CTX_AGENT_DIR: agentDir,
        CTX_ORG: 'acme',
        CTX_INSTANCE_ID: 'sigterm-test',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Rename CTX_AGENT_NAME but reuse the same on-disk agent files — the
    // bus uses CTX_AGENT_NAME to scope events.
    await waitForReady(proc);

    await new Promise<number | null>((resolve) => {
      proc!.once('exit', (code) => resolve(code));
      proc!.kill('SIGTERM');
    });

    const today = new Date().toISOString().split('T')[0];
    const eventFile = join(ctxRoot, 'orgs', 'acme', 'analytics', 'events', 'rag-evt', `${today}.jsonl`);
    expect(existsSync(eventFile)).toBe(true);
    const lines = readFileSync(eventFile, 'utf-8').trim().split('\n');
    const events = lines.map(l => JSON.parse(l));

    // The runner emits agent_online at boot and agent_offline at SIGTERM.
    // Both should be present.
    const onlineEvent = events.find(e => e.event === 'agent_online');
    const offlineEvent = events.find(e => e.event === 'agent_offline');
    expect(onlineEvent).toBeDefined();
    expect(offlineEvent).toBeDefined();
    expect(offlineEvent.category).toBe('milestone');
    expect(offlineEvent.metadata.agent).toBe('rag-evt');
  });

  it('exits cleanly within the 5s grace window', async () => {
    proc = spawn(TSX_BIN, RUN_ARGS, {
      env: {
        ...process.env,
        HOME: tempRoot,
        CTX_AGENT_NAME: 'rag-fast',
        CTX_AGENT_DIR: agentDir,
        CTX_ORG: 'acme',
        CTX_INSTANCE_ID: 'sigterm-test',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    await waitForReady(proc);

    const sigtermSentAt = Date.now();
    await new Promise<number | null>((resolve) => {
      proc!.once('exit', (code) => resolve(code));
      proc!.kill('SIGTERM');
    });
    const elapsedMs = Date.now() - sigtermSentAt;

    // AgentProcess.stop() sleeps 5s after SIGTERM before falling back to
    // SIGHUP. The runner should exit well within that window — synchronous
    // bus writes plus process.exit() typically clear in under 100ms. The
    // generous bound here just guards against pathological delays.
    expect(elapsedMs).toBeLessThan(3000);
  });
});
