/**
 * Dispatch-allowlist guard at the TOP of AgentProcess.start() refuses any
 * runtime not in {claude-code, codex-app-server, hermes, openai-compatible}.
 *
 * Why this guard exists: AgentConfig.runtime is type-optional (legacy Claude
 * agents on disk have no runtime field) and the dispatch ternary at
 * agent-process.ts:117-121 routes anything-not-Hermes-not-Codex-not-thin to
 * AgentPTY. Without the guard, an unknown runtime string in config.json
 * would silently dispatch through the Claude path.
 *
 * The guard sits at start() because that's the single chokepoint for all
 * five spawn paths (cold start, IPC start-agent, CLI cortextos start, crash
 * auto-restart, session refresh). One check covers them all.
 *
 * History: PR1 introduced the guard with openai-compatible deliberately OFF
 * the allowlist (the type union was extended but no PTY dispatch case
 * existed yet). PR2 added 'openai-compatible' to the allowlist alongside
 * the OpenAICompatiblePTY dispatch branch.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let capturedOnExit: ((exitCode: number, signal?: number) => void) | null = null;

function makeMockPty() {
  return {
    spawn: vi.fn().mockResolvedValue(undefined),
    kill: vi.fn(),
    write: vi.fn(),
    getPid: vi.fn().mockReturnValue(12345),
    isAlive: vi.fn().mockReturnValue(true),
    onExit: vi.fn().mockImplementation((cb: (exitCode: number, signal?: number) => void) => {
      capturedOnExit = cb;
    }),
  };
}

// Separate mock instances per runtime so we can check which constructor was
// chosen by looking at which one's spawn() was called.
const mockClaudePty = makeMockPty();
const mockCodexPty = makeMockPty();
const mockHermesPty = makeMockPty();
const mockOpenAIPty = makeMockPty();

vi.mock('../../../src/pty/agent-pty.js', () => ({
  AgentPTY: function AgentPTY() { return mockClaudePty; },
}));

vi.mock('../../../src/pty/codex-app-server-pty.js', () => ({
  CodexAppServerPTY: function CodexAppServerPTY() { return mockCodexPty; },
}));

vi.mock('../../../src/pty/hermes-pty.js', () => ({
  HermesPTY: function HermesPTY() { return mockHermesPty; },
  hermesDbExists: vi.fn().mockReturnValue(false),
}));

vi.mock('../../../src/pty/openai-compatible-pty.js', () => ({
  OpenAICompatiblePTY: function OpenAICompatiblePTY() { return mockOpenAIPty; },
}));

vi.mock('../../../src/pty/inject.js', () => ({
  injectMessage: vi.fn(),
  MessageDedup: class { isDuplicate() { return false; } },
}));

vi.mock('../../../src/utils/atomic.js', () => ({
  ensureDir: vi.fn(),
  atomicWriteSync: vi.fn(),
}));

vi.mock('../../../src/utils/env.js', () => ({
  writeCortextosEnv: vi.fn(),
  resolveEnv: vi.fn().mockReturnValue({ instanceId: 'test', ctxRoot: '/tmp/test' }),
}));

vi.mock('../../../src/bus/reminders.js', () => ({
  getOverdueReminders: vi.fn().mockReturnValue([]),
}));

vi.mock('../../../src/utils/paths.js', () => ({
  resolvePaths: vi.fn().mockReturnValue({}),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    mkdirSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    appendFileSync: vi.fn(),
    statSync: vi.fn(),
  };
});

const { AgentProcess } = await import('../../../src/daemon/agent-process.js');

const mockEnv = {
  instanceId: 'test',
  ctxRoot: '/tmp/test-ctx',
  frameworkRoot: '/tmp/fw',
  agentName: 'specimen',
  agentDir: '/tmp/fw/orgs/acme/agents/specimen',
  org: 'acme',
  projectRoot: '/tmp/fw',
};

beforeEach(() => {
  capturedOnExit = null;
  mockClaudePty.spawn.mockClear();
  mockCodexPty.spawn.mockClear();
  mockHermesPty.spawn.mockClear();
  mockOpenAIPty.spawn.mockClear();
});

describe('AgentProcess dispatch-allowlist guard', () => {
  it('passes runtime=openai-compatible through to OpenAICompatiblePTY (allowlist hit, PR2)', async () => {
    const ap = new AgentProcess('specimen', mockEnv, { runtime: 'openai-compatible' } as any);
    await ap.start();
    expect(mockOpenAIPty.spawn).toHaveBeenCalled();
    expect(mockClaudePty.spawn).not.toHaveBeenCalled();
    expect(mockCodexPty.spawn).not.toHaveBeenCalled();
    expect(mockHermesPty.spawn).not.toHaveBeenCalled();
  });

  it('refuses a genuinely unknown runtime via the same code path', async () => {
    const logCalls: string[] = [];
    const ap = new AgentProcess('specimen', mockEnv, { runtime: 'totally-bogus' } as any, (msg) => logCalls.push(msg));

    await ap.start();

    expect(mockClaudePty.spawn).not.toHaveBeenCalled();
    expect(mockCodexPty.spawn).not.toHaveBeenCalled();
    expect(mockHermesPty.spawn).not.toHaveBeenCalled();
    expect(logCalls.some(m => /Refusing to dispatch.*totally-bogus.*not in allowlist/.test(m))).toBe(true);
  });

  it('passes runtime=hermes through to HermesPTY (allowlist hit)', async () => {
    const ap = new AgentProcess('specimen', mockEnv, { runtime: 'hermes' } as any);
    await ap.start();
    expect(mockHermesPty.spawn).toHaveBeenCalled();
    expect(mockClaudePty.spawn).not.toHaveBeenCalled();
  });

  it('passes runtime=codex-app-server through to CodexAppServerPTY (allowlist hit)', async () => {
    const ap = new AgentProcess('specimen', mockEnv, { runtime: 'codex-app-server' } as any);
    await ap.start();
    expect(mockCodexPty.spawn).toHaveBeenCalled();
    expect(mockClaudePty.spawn).not.toHaveBeenCalled();
  });

  it('passes runtime=claude-code through to AgentPTY (allowlist hit)', async () => {
    const ap = new AgentProcess('specimen', mockEnv, { runtime: 'claude-code' } as any);
    await ap.start();
    expect(mockClaudePty.spawn).toHaveBeenCalled();
    expect(mockCodexPty.spawn).not.toHaveBeenCalled();
    expect(mockHermesPty.spawn).not.toHaveBeenCalled();
  });
});
