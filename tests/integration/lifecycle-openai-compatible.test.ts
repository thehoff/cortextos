/**
 * PR2 (openai-compatible runtime): AgentProcess ↔ OpenAICompatiblePTY
 * lifecycle integration.
 *
 * Pins the daemon-side wiring for an openai-compatible agent:
 *
 *   1. AgentProcess.start() picks OpenAICompatiblePTY (not AgentPTY,
 *      not CodexAppServerPTY) when config.runtime === 'openai-compatible'.
 *   2. injectMessage() flows into the PTY's write() (where bracketed-paste
 *      markers get stripped — that's covered by the PTY unit test).
 *   3. AgentProcess.stop() for openai-compatible calls
 *      OpenAICompatiblePTY.signalShutdown() (SIGTERM) BEFORE any forceful
 *      kill — verifies the new stop branch in agent-process.ts.
 *
 * This is the in-process lifecycle peer to tests/e2e/lifecycle-codex.test.ts;
 * the on-the-wire LLM HTTP contract is exercised by
 * tests/integration/runner-memory-header.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// AgentProcess.stop() awaits an exitPromise that the PTY's onExit handler
// resolves. With a fully passive mock, that promise never resolves and
// stop() blocks on its 15s race timeout. Capture the onExit callback here
// so tests can fire it manually to simulate clean exit.
let openaiOnExitCb: ((exitCode: number, signal?: number) => void) | null = null;

const mockOpenAIPty = {
  spawn: vi.fn().mockResolvedValue(undefined),
  write: vi.fn(),
  kill: vi.fn(),
  signalShutdown: vi.fn(),
  getPid: vi.fn().mockReturnValue(70000),
  isAlive: vi.fn().mockReturnValue(true),
  onExit: vi.fn().mockImplementation((cb: (exitCode: number, signal?: number) => void) => {
    openaiOnExitCb = cb;
  }),
  getOutputBuffer: vi.fn().mockReturnValue({
    isBootstrapped: () => true,
    getRecent: () => '',
  }),
};
const mockClaudePty = {
  spawn: vi.fn().mockResolvedValue(undefined),
  write: vi.fn(),
  kill: vi.fn(),
  getPid: vi.fn().mockReturnValue(71000),
  isAlive: vi.fn().mockReturnValue(true),
  onExit: vi.fn(),
  getOutputBuffer: vi.fn().mockReturnValue({ isBootstrapped: () => true, getRecent: () => '' }),
};

vi.mock('../../src/pty/openai-compatible-pty.js', () => ({
  OpenAICompatiblePTY: function OpenAICompatiblePTY() { return mockOpenAIPty; },
}));
vi.mock('../../src/pty/agent-pty.js', () => ({
  AgentPTY: function AgentPTY() { return mockClaudePty; },
}));
vi.mock('../../src/pty/codex-app-server-pty.js', () => ({
  CodexAppServerPTY: function CodexAppServerPTY() { return {}; },
}));
vi.mock('../../src/pty/hermes-pty.js', () => ({
  HermesPTY: function HermesPTY() { return {}; },
  hermesDbExists: vi.fn().mockReturnValue(false),
}));

vi.mock('../../src/pty/inject.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/pty/inject.js')>('../../src/pty/inject.js');
  return {
    ...actual,
    // The real injectMessage adds bracketed-paste markers and schedules an
    // Enter via setTimeout. For the lifecycle assertion we just need the
    // synchronous "calls write()" half — strip the setTimeout so the test
    // doesn't have to wait on a real timer.
    injectMessage: (write: (data: string) => void, content: string) => {
      write('\x1b[200~' + content + '\x1b[201~');
    },
  };
});

vi.mock('../../src/utils/atomic.js', () => ({
  ensureDir: vi.fn(),
  atomicWriteSync: vi.fn(),
}));
vi.mock('../../src/utils/env.js', () => ({
  writeCortextosEnv: vi.fn(),
  resolveEnv: vi.fn().mockReturnValue({ instanceId: 'test', ctxRoot: '/tmp/test' }),
}));
vi.mock('../../src/bus/reminders.js', () => ({
  getOverdueReminders: vi.fn().mockReturnValue([]),
}));
vi.mock('../../src/utils/paths.js', () => ({
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

const { AgentProcess } = await import('../../src/daemon/agent-process.js');

const mockEnv = {
  instanceId: 'lifecycle-test',
  ctxRoot: '/tmp/lifecycle-ctx',
  frameworkRoot: '/tmp/fw',
  agentName: 'rag-life',
  agentDir: '/tmp/fw/orgs/acme/agents/rag-life',
  org: 'acme',
  projectRoot: '/tmp/fw',
};

beforeEach(() => {
  mockOpenAIPty.spawn.mockClear();
  mockOpenAIPty.write.mockClear();
  mockOpenAIPty.kill.mockClear();
  mockOpenAIPty.signalShutdown.mockClear();
  mockOpenAIPty.isAlive.mockReturnValue(true);
  mockClaudePty.spawn.mockClear();
  openaiOnExitCb = null;
});

describe('PR2: openai-compatible AgentProcess lifecycle', { timeout: 20_000 }, () => {
  it('dispatches runtime=openai-compatible to OpenAICompatiblePTY (not AgentPTY)', async () => {
    const ap = new AgentProcess('rag-life', mockEnv, { runtime: 'openai-compatible' } as any);
    await ap.start();
    expect(mockOpenAIPty.spawn).toHaveBeenCalledTimes(1);
    expect(mockClaudePty.spawn).not.toHaveBeenCalled();
    expect(ap.getStatus().status).toBe('running');
    expect(ap.getStatus().pid).toBe(70000);
  });

  it('injectMessage routes through OpenAICompatiblePTY.write()', async () => {
    const ap = new AgentProcess('rag-life', mockEnv, { runtime: 'openai-compatible' } as any);
    await ap.start();
    const accepted = ap.injectMessage('=== AGENT MESSAGE from human [msg_id: m1] ===\n```\nhi\n```\n');
    expect(accepted).toBe(true);
    expect(mockOpenAIPty.write).toHaveBeenCalledTimes(1);
    // The lifecycle test's injectMessage mock above wraps in bracketed-paste
    // markers; the real OpenAICompatiblePTY.write() strips them. We're
    // asserting the routing here, not the stripping (covered separately).
    expect(mockOpenAIPty.write.mock.calls[0][0]).toContain('=== AGENT MESSAGE from human [msg_id: m1] ===');
  });

  it('stop() calls signalShutdown() (SIGTERM) before falling back to kill()', async () => {
    const ap = new AgentProcess('rag-life', mockEnv, { runtime: 'openai-compatible' } as any);
    await ap.start();

    // Simulate the runner exiting cleanly after SIGTERM by flipping isAlive
    // and firing the captured onExit callback (which resolves the
    // exitPromise that stop() awaits). This skips the fallback kill() and
    // lets the 15s race resolve immediately.
    mockOpenAIPty.signalShutdown.mockImplementationOnce(() => {
      mockOpenAIPty.isAlive.mockReturnValue(false);
      openaiOnExitCb?.(0);
    });

    await ap.stop();

    expect(mockOpenAIPty.signalShutdown).toHaveBeenCalledTimes(1);
    // Since the runner "exited" (isAlive=false) after signalShutdown, the
    // shared kill() fallback should NOT have fired.
    expect(mockOpenAIPty.kill).not.toHaveBeenCalled();
    expect(ap.getStatus().status).toBe('stopped');
  });

  it('stop() falls back to forceful kill() when the runner doesn\'t exit on SIGTERM', async () => {
    const ap = new AgentProcess('rag-life', mockEnv, { runtime: 'openai-compatible' } as any);
    await ap.start();

    // Simulate the SIGTERM-ignoring case: signalShutdown does nothing,
    // isAlive stays true after the 5s grace, the shared fallback fires.
    // kill() then "succeeds" — fire the onExit callback so the exitPromise
    // race inside stop() resolves immediately rather than waiting 15s.
    mockOpenAIPty.signalShutdown.mockImplementation(() => { /* swallow */ });
    mockOpenAIPty.kill.mockImplementation(() => {
      mockOpenAIPty.isAlive.mockReturnValue(false);
      openaiOnExitCb?.(143);
    });

    await ap.stop();

    expect(mockOpenAIPty.signalShutdown).toHaveBeenCalledTimes(1);
    expect(mockOpenAIPty.kill).toHaveBeenCalledTimes(1);
  });
});
