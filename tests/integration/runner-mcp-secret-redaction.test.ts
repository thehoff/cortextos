/**
 * PR5 (MCP support) — secret-redaction integration test
 * (Codex pass-3 PR5-025 + PR5-029 verification).
 *
 * Boot the runner with an MCP server whose `env.TOKEN: "$VAR"` resolves
 * a known secret value into the subprocess env. The fixture echoes that
 * env var back via an isError:true tool result. Assert:
 *   - The secret value DOES NOT appear in the runner's stderr.
 *   - The secret value DOES NOT appear in the tool-message reply that
 *     the runner sends back to the LLM (verified by inspecting the
 *     second mock-LLM request body — which contains the prior tool
 *     output as a role:tool message).
 *
 * Without the loop.ts redaction at the MCP-error path + the new boot
 * redaction in run-openai-agent.ts, the secret value would leak into
 * the LLM-visible tool message AND into the next turn's analytics.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { createServer, type Server } from 'http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { AddressInfo } from 'net';

const REPO_ROOT = join(__dirname, '..', '..');
const TSX_BIN = join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const CLI_SRC = join(REPO_ROOT, 'src', 'cli', 'index.ts');
const LEAK_FIXTURE = join(REPO_ROOT, 'tests', 'fixtures', 'mcp', 'server-error-leak.ts');

const RUNNER_ENV_SECRET = 'sk-runner-secret-9b7e3a1d';

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

describe('PR5 runner + MCP secret redaction', { timeout: 30_000 }, () => {
  let tempRoot: string;
  let agentDir: string;
  let ctxRoot: string;
  let proc: ChildProcess | null = null;
  let mockLlm: Server;
  let endpoint: string;
  let receivedBodies: string[];
  let llmTurns: number;

  beforeEach(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'pr5-secret-'));
    agentDir = join(tempRoot, 'project', 'orgs', 'acme', 'agents', 'rag');
    ctxRoot = join(tempRoot, '.cortextos', 'secret-test');
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'),
      JSON.stringify({ rag: { enabled: true, org: 'acme' } }));
    receivedBodies = [];
    llmTurns = 0;

    mockLlm = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        receivedBodies.push(Buffer.concat(chunks).toString('utf-8'));
        llmTurns++;
        let body;
        if (llmTurns === 1) {
          body = {
            choices: [{
              message: {
                role: 'assistant', content: null,
                tool_calls: [{ id: 'c1', type: 'function', function: { name: 'mcp__leak__fail_with_secret', arguments: '{}' } }],
              },
            }],
          };
        } else {
          body = { choices: [{ message: { role: 'assistant', content: 'noted' } }] };
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
      tools: ['mcp__leak__fail_with_secret'],
      mcp_servers: [{
        name: 'leak', command: TSX_BIN, args: [LEAK_FIXTURE],
        env: { MCP_LEAK_SECRET: '$PR5_RUNNER_SECRET' },
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

  it('redacts $VAR-resolved secrets from MCP tool errors that flow into LLM-visible tool messages', async () => {
    proc = spawn(TSX_BIN, [CLI_SRC, 'run-openai-agent'], {
      env: {
        ...process.env, HOME: tempRoot,
        CTX_AGENT_NAME: 'rag', CTX_AGENT_DIR: agentDir,
        CTX_ORG: 'acme', CTX_INSTANCE_ID: 'secret-test',
        // The $VAR that the spec.env entry references. The runner reads
        // this once at boot, the manager tracks it as a secret, and any
        // tool error containing the value must be redacted.
        PR5_RUNNER_SECRET: RUNNER_ENV_SECRET,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderr = '';
    proc.stderr!.on('data', (c) => { stderr += c.toString(); });

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
      '```', 'trigger the leak', '```',
      `Reply using: cortextos bus send-message human normal '<your reply>' m1`, '',
    ].join('\n'));

    const inboxDir = join(ctxRoot, 'inbox', 'human');
    const start = Date.now();
    while (Date.now() - start < 25_000) {
      if (existsSync(inboxDir) && readdirSync(inboxDir).some(f => f.endsWith('.json'))) break;
      await sleep(100);
    }

    // The runner sent at least the original prompt + the tool error reply
    // back to the LLM. The second-or-later body contains the tool message.
    expect(receivedBodies.length).toBeGreaterThanOrEqual(2);
    const allBodies = receivedBodies.join('\n');
    expect(allBodies).not.toContain(RUNNER_ENV_SECRET);
    expect(stderr).not.toContain(RUNNER_ENV_SECRET);
  });
});
