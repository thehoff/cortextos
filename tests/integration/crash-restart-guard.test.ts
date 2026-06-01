/**
 * PR1 integration: the dispatch-allowlist guard sits at the TOP of
 * AgentProcess.start() — the single chokepoint for every spawn path. One
 * of those paths is the crash-recovery setTimeout at agent-process.ts:476-480,
 * which calls `this.start()` after an exponential-backoff delay.
 *
 * This test pins the call-site invariant: repeated invocations of start()
 * (which is what crash recovery, IPC redelivery, and other retry paths
 * effectively do) all route through the guard. No retry path can
 * accidentally bypass it.
 *
 * Why not exercise the real setTimeout: in PR1, unsupported-runtime is OFF
 * the allowlist, so the first start() rejects immediately and crash
 * recovery never schedules a retry. The meaningful invariant is that the
 * guard catches every start() invocation, which is what we verify here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let capturedOnExit: ((exitCode: number, signal?: number) => void) | null = null;

const mockClaudePty = {
  spawn: vi.fn().mockResolvedValue(undefined),
  kill: vi.fn(),
  write: vi.fn(),
  getPid: vi.fn().mockReturnValue(99002),
  isAlive: vi.fn().mockReturnValue(true),
  onExit: vi.fn().mockImplementation((cb: (exitCode: number, signal?: number) => void) => {
    capturedOnExit = cb;
  }),
};

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

vi.mock('../../src/pty/inject.js', () => ({
  injectMessage: vi.fn(),
  MessageDedup: class { isDuplicate() { return false; } },
}));

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
  instanceId: 'pr1-crash-test',
  ctxRoot: '/tmp/test-ctx',
  frameworkRoot: '/tmp/fw',
  agentName: 'crash-test',
  agentDir: '/tmp/fw/orgs/acme/agents/crash-test',
  org: 'acme',
  projectRoot: '/tmp/fw',
};

beforeEach(() => {
  capturedOnExit = null;
  mockClaudePty.spawn.mockClear();
});

describe('PR1 integration: crash-restart path routes through the guard', () => {
  it('repeated start() calls on an unsupported runtime all refused, never spawning a PTY', async () => {
    // Crash recovery schedules `this.start()` via setTimeout (agent-process.ts:476-480).
    // Successive invocations on the same instance simulate that loop.
    const logCalls: string[] = [];
    const ap = new AgentProcess(
      'crash-test',
      mockEnv,
      { runtime: 'unsupported-runtime' } as any,
      (msg) => logCalls.push(msg),
    );

    // First start() — initial dispatch attempt.
    await ap.start();
    // Second start() — what the crash-recovery setTimeout would call.
    await ap.start();
    // Third start() — second crash recovery (backoff would grow but logic is same).
    await ap.start();

    expect(mockClaudePty.spawn).not.toHaveBeenCalled();
    expect(ap.getStatus().status).toBe('stopped'); // never moved to 'starting' / 'running'

    const rejections = logCalls.filter(m => /Refusing to dispatch.*unsupported-runtime/.test(m));
    expect(rejections.length).toBe(3);
  });

  it('the guard does not increment the crash counter — refused starts are not crashes', async () => {
    // crashCount is incremented inside handleExit, which only fires after a
    // PTY exits. The guard returns BEFORE any PTY is constructed, so the
    // crash counter must remain at 0 across repeated refused starts.
    const ap = new AgentProcess(
      'crash-counter',
      mockEnv,
      { runtime: 'unsupported-runtime' } as any,
    );

    await ap.start();
    await ap.start();
    await ap.start();

    expect(ap.getStatus().crashCount).toBe(0);
  });
});
