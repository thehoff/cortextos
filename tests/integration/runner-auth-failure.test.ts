/**
 * PR4 (provider polish) Codex pass-1 PR4-005: operator-facing diagnostic
 * on 401/403 from the LLM endpoint, and runner exit after 3 consecutive
 * auth failures so PM2 surfaces the unhealthy state.
 *
 * Setup: spawn the runner with `api_key_env: "TEST_OPENROUTER_KEY"`,
 * point it at a mock LLM server that always returns 401 with a body
 * that echoes the bearer token. Then send inbox messages and assert:
 *   1. Reply contains "LLM authentication failed", the provider tag,
 *      and the env-var name.
 *   2. Reply does NOT contain the resolved API key (PR4-001 redaction
 *      chain wires through end-to-end).
 *   3. agent_auth_failed event lands in the analytics stream.
 *   4. After 3 consecutive auth failures, the runner exits non-zero.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { createServer, type Server } from 'http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { AddressInfo } from 'net';

const TSX_BIN = join(__dirname, '..', '..', 'node_modules', '.bin', 'tsx');
const CLI_SRC = join(__dirname, '..', '..', 'src', 'cli', 'index.ts');
const RUN_ARGS = [CLI_SRC, 'run-openai-agent'];

const LIVE_KEY = 'sk-or-test-do-not-leak-1234567890-abcdef';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('PR4: auth-failure diagnostic and 3-strike exit', { timeout: 30_000 }, () => {
  let tempRoot: string;
  let agentDir: string;
  let ctxRoot: string;
  let proc: ChildProcess | null = null;
  let mockServer: Server;
  let endpoint: string;
  let requestCount: number;

  beforeEach(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'pr4-auth-fail-'));
    agentDir = join(tempRoot, 'project', 'orgs', 'acme', 'agents', 'rag-a');
    ctxRoot = join(tempRoot, '.cortextos', 'auth-fail-test');
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(ctxRoot, { recursive: true });
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'),
      JSON.stringify({ 'rag-a': { enabled: true, org: 'acme' } }));
    requestCount = 0;

    mockServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        requestCount++;
        res.statusCode = 401;
        res.setHeader('Content-Type', 'application/json');
        // Echo the live key in the body — this is the leak vector PR4-001
        // closes. The reply we send back to the human inbox must not
        // contain LIVE_KEY.
        res.end(JSON.stringify({
          error: `Authorization Bearer ${LIVE_KEY} rejected; key invalid or expired`,
        }));
      });
    });
    await new Promise<void>(resolve => mockServer.listen(0, '127.0.0.1', () => resolve()));
    const port = (mockServer.address() as AddressInfo).port;
    endpoint = `http://127.0.0.1:${port}`;

    writeFileSync(join(agentDir, 'config.json'), JSON.stringify({
      agent_name: 'rag-a',
      runtime: 'openai-compatible',
      enabled: true,
      endpoint,
      model: 'test',
      api_key_env: 'TEST_OPENROUTER_KEY',
      provider: 'openrouter',
      heartbeat_interval_sec: 60,
      request_timeout_sec: 5,
      tools: [],
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
    await new Promise<void>(resolve => mockServer.close(() => resolve()));
    await sleep(50);
    try { rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* */ }
  });

  function spawnRunner(): ChildProcess {
    return spawn(TSX_BIN, RUN_ARGS, {
      env: {
        ...process.env,
        HOME: tempRoot,
        CTX_AGENT_NAME: 'rag-a',
        CTX_AGENT_DIR: agentDir,
        CTX_ORG: 'acme',
        CTX_INSTANCE_ID: 'auth-fail-test',
        TEST_OPENROUTER_KEY: LIVE_KEY,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  async function waitForReady(p: ChildProcess): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let buffer = '';
      const t = setTimeout(() => reject(new Error('READY timeout')), 10_000);
      p.stdout!.on('data', (c) => {
        buffer += c.toString();
        if (buffer.includes('[openai-runner] READY')) {
          clearTimeout(t); resolve();
        }
      });
    });
  }

  function sendMessage(p: ChildProcess, msgId: string, content = 'hello'): void {
    p.stdin!.write([
      `=== AGENT MESSAGE from human [msg_id: ${msgId}] ===`,
      '```', content, '```',
      `Reply using: cortextos bus send-message human normal '<your reply>' ${msgId}`, '',
    ].join('\n'));
  }

  function readHumanInboxReplies(): any[] {
    const inboxDir = join(ctxRoot, 'inbox', 'human');
    if (!existsSync(inboxDir)) return [];
    return readdirSync(inboxDir)
      .filter(f => f.endsWith('.json'))
      .map(f => JSON.parse(readFileSync(join(inboxDir, f), 'utf-8')));
  }

  it('replies with a sanitized actionable hint on 401 and never echoes the live key', async () => {
    proc = spawnRunner();
    await waitForReady(proc);

    sendMessage(proc, 'auth-1');
    const start = Date.now();
    while (readHumanInboxReplies().length < 1 && Date.now() - start < 10_000) {
      await sleep(50);
    }
    const replies = readHumanInboxReplies();
    expect(replies.length).toBeGreaterThanOrEqual(1);
    const reply = replies[0];
    const body: string = reply.text ?? '';
    expect(body).toContain('LLM authentication failed');
    expect(body).toContain('openrouter');
    expect(body).toContain('TEST_OPENROUTER_KEY');
    expect(body).toContain('HTTP 401');
    // The cornerstone assertion: the live key must NOT appear anywhere
    // in the reply body, no matter how the upstream echoed it.
    expect(body).not.toContain(LIVE_KEY);
  });

  it('logs structured agent_auth_failed event with provider + api_key_env', async () => {
    proc = spawnRunner();
    await waitForReady(proc);

    sendMessage(proc, 'auth-evt-1');
    const start = Date.now();
    while (readHumanInboxReplies().length < 1 && Date.now() - start < 10_000) {
      await sleep(50);
    }
    await sleep(200); // give the analytics writer a tick to flush.

    const today = new Date().toISOString().split('T')[0];
    const eventsPath = join(ctxRoot, 'orgs', 'acme', 'analytics', 'events', 'rag-a', `${today}.jsonl`);
    const events = readFileSync(eventsPath, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    const authEvt = events.find((e: any) => e.event === 'agent_auth_failed');
    expect(authEvt).toBeDefined();
    expect(authEvt.metadata.status).toBe(401);
    expect(authEvt.metadata.provider).toBe('openrouter');
    expect(authEvt.metadata.api_key_env).toBe('TEST_OPENROUTER_KEY');
    expect(authEvt.metadata.endpoint).toBe(endpoint);
  });

  it('exits with non-zero status after 3 consecutive auth failures', async () => {
    proc = spawnRunner();
    await waitForReady(proc);

    const exitPromise = new Promise<number | null>((resolve) => {
      proc!.once('exit', (code) => resolve(code));
    });

    sendMessage(proc, 'strike-1');
    sendMessage(proc, 'strike-2');
    sendMessage(proc, 'strike-3');

    // Wait for the runner to give up on its own.
    const exitCode = await Promise.race([
      exitPromise,
      sleep(10_000).then(() => 'timeout' as const),
    ]);
    expect(exitCode).not.toBe('timeout');
    expect(exitCode).not.toBe(0);
    expect(requestCount).toBeGreaterThanOrEqual(3);
  });
});
