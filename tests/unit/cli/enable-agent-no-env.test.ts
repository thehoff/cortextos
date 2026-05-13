/**
 * PR2 (openai-compatible runtime): `cortextos enable` must succeed for an
 * openai-compatible agent that has no `.env` file.
 *
 * Why this test exists: pre-PR2, `enable-agent.ts:155-174` searched for an
 * agent `.env` and hard-failed with process.exit(1) if it didn't find one.
 * Openai-compatible agents are scaffolded without `.env` by design (no
 * Telegram path, no BOT_TOKEN/CHAT_ID). PR2 reads config.json runtime
 * BEFORE the .env discovery block and short-circuits when runtime is
 * openai-compatible — the test verifies all three pieces:
 *
 *   1. No process.exit(1) on missing .env
 *   2. enabled-agents.json is updated (registration succeeds)
 *   3. State dirs are created (downstream code expects them)
 *
 * Also pins the no-regression case: an openai-compatible agent with a stray
 * .env that's missing BOT_TOKEN/CHAT_ID still succeeds (the preflight is
 * skipped entirely, not just made lenient).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock the IPC client so enable doesn't try to talk to a non-existent daemon.
vi.mock('../../../src/daemon/ipc-server.js', () => ({
  IPCClient: class {
    async isDaemonRunning(): Promise<boolean> { return false; }
    async send(): Promise<{ success: boolean }> { return { success: false }; }
  },
}));

describe('PR2: enable-agent with openai-compatible runtime (no .env required)', () => {
  let tempRoot: string;
  let tempHome: string;
  let originalHome: string | undefined;
  let originalCwd: string | undefined;
  let originalFrameworkRoot: string | undefined;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'pr2-enable-noenv-'));
    tempHome = mkdtempSync(join(tmpdir(), 'pr2-enable-noenv-home-'));
    originalHome = process.env.HOME;
    originalCwd = process.env.CTX_PROJECT_ROOT;
    originalFrameworkRoot = process.env.CTX_FRAMEWORK_ROOT;
    process.env.HOME = tempHome;
    process.env.CTX_FRAMEWORK_ROOT = tempRoot;
    process.env.CTX_PROJECT_ROOT = tempRoot;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalCwd === undefined) delete process.env.CTX_PROJECT_ROOT;
    else process.env.CTX_PROJECT_ROOT = originalCwd;
    if (originalFrameworkRoot === undefined) delete process.env.CTX_FRAMEWORK_ROOT;
    else process.env.CTX_FRAMEWORK_ROOT = originalFrameworkRoot;
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(tempHome, { recursive: true, force: true });
  });

  function makeOpenAIAgent(name: string): string {
    const agentDir = join(tempRoot, 'orgs', 'testorg', 'agents', name);
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'config.json'), JSON.stringify({
      agent_name: name,
      runtime: 'openai-compatible',
      enabled: true,
      endpoint: 'http://localhost:8080',
      model: 'lfm2-8b',
    }, null, 2));
    writeFileSync(join(agentDir, 'SYSTEM_PROMPT.md'), 'You are a helpful agent.\n');
    return agentDir;
  }

  it('succeeds with NO .env present and registers the agent enabled=true', async () => {
    makeOpenAIAgent('rag-noenv');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { enableAgentCommand } = await import('../../../src/cli/enable-agent');
    // parseAsync should resolve cleanly — no process.exit(1) on missing .env.
    await enableAgentCommand.parseAsync([
      'node', 'cli', 'rag-noenv', '--org', 'testorg', '--instance', 'pr2-noenv-test',
    ]);

    const registryPath = join(tempHome, '.cortextos', 'pr2-noenv-test', 'config', 'enabled-agents.json');
    expect(existsSync(registryPath)).toBe(true);
    const registry = JSON.parse(readFileSync(registryPath, 'utf-8'));
    expect(registry['rag-noenv']).toBeDefined();
    expect(registry['rag-noenv'].enabled).toBe(true);
    expect(registry['rag-noenv'].org).toBe('testorg');
  });

  it('creates the per-agent state directories under ~/.cortextos/<instance>/', async () => {
    makeOpenAIAgent('rag-state');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { enableAgentCommand } = await import('../../../src/cli/enable-agent');

    await enableAgentCommand.parseAsync([
      'node', 'cli', 'rag-state', '--org', 'testorg', '--instance', 'pr2-noenv-test',
    ]);

    const ctxRoot = join(tempHome, '.cortextos', 'pr2-noenv-test');
    for (const dir of ['inbox', 'inflight', 'processed', 'outbox', 'logs', 'state']) {
      expect(existsSync(join(ctxRoot, dir, 'rag-state'))).toBe(true);
    }
  });

  it('logs that the Telegram preflight is being skipped', async () => {
    makeOpenAIAgent('rag-log');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { enableAgentCommand } = await import('../../../src/cli/enable-agent');

    await enableAgentCommand.parseAsync([
      'node', 'cli', 'rag-log', '--org', 'testorg', '--instance', 'pr2-noenv-test',
    ]);

    const messages = logSpy.mock.calls.map(c => String(c[0]));
    expect(messages.some(m => /openai-compatible/.test(m) && /skipping.*Telegram/i.test(m))).toBe(true);
  });

  it('ignores a stray .env without BOT_TOKEN/CHAT_ID (preflight is skipped wholesale)', async () => {
    const agentDir = makeOpenAIAgent('rag-stray');
    // Plant a malformed .env to prove the preflight isn't just made lenient —
    // it's bypassed entirely for openai-compatible.
    writeFileSync(join(agentDir, '.env'), '# stray file, no creds\n');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { enableAgentCommand } = await import('../../../src/cli/enable-agent');

    await expect(enableAgentCommand.parseAsync([
      'node', 'cli', 'rag-stray', '--org', 'testorg', '--instance', 'pr2-noenv-test',
    ])).resolves.toBeDefined();

    // Registration still completes.
    const registryPath = join(tempHome, '.cortextos', 'pr2-noenv-test', 'config', 'enabled-agents.json');
    const registry = JSON.parse(readFileSync(registryPath, 'utf-8'));
    expect(registry['rag-stray'].enabled).toBe(true);
  });
});
