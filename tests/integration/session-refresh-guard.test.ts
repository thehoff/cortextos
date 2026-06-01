/**
 * PR1 integration: session-refresh path routes through the dispatch
 * allowlist guard.
 *
 * AgentProcess.sessionRefresh() at agent-process.ts:307-312 is:
 *   async sessionRefresh() { await this.stop(); await this.start(); }
 *
 * It's triggered by FastChecker (fast-checker.ts:1062) when a session
 * boundary is reached. Because it routes through `start()`, the guard at
 * the top of start() catches it the same way it catches every other
 * spawn path.
 *
 * This test exercises that path directly: call sessionRefresh() on an
 * unsupported-runtime agent and verify the start() half is intercepted,
 * the stop() half is harmless (no PTY to stop), and sessionRefresh
 * returns cleanly without leaving the agent in a half-started state.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let capturedOnExit: ((exitCode: number, signal?: number) => void) | null = null;

const mockClaudePty = {
  spawn: vi.fn().mockResolvedValue(undefined),
  kill: vi.fn(),
  write: vi.fn(),
  getPid: vi.fn().mockReturnValue(99003),
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
  instanceId: 'pr1-refresh-test',
  ctxRoot: '/tmp/test-ctx',
  frameworkRoot: '/tmp/fw',
  agentName: 'refresh-test',
  agentDir: '/tmp/fw/orgs/acme/agents/refresh-test',
  org: 'acme',
  projectRoot: '/tmp/fw',
};

beforeEach(() => {
  capturedOnExit = null;
  mockClaudePty.spawn.mockClear();
  mockClaudePty.kill.mockClear();
});

describe('PR1 integration: session refresh routes through the guard', () => {
  it('sessionRefresh() on an unsupported runtime: start() half intercepted, no PTY spawned', async () => {
    const logCalls: string[] = [];
    const ap = new AgentProcess(
      'refresh-test',
      mockEnv,
      { runtime: 'unsupported-runtime' } as any,
      (msg) => logCalls.push(msg),
    );

    await ap.sessionRefresh();

    expect(mockClaudePty.spawn).not.toHaveBeenCalled();
    expect(mockClaudePty.kill).not.toHaveBeenCalled(); // no PTY to kill — stop() was a no-op
    expect(logCalls.some(m => /Refusing to dispatch.*unsupported-runtime.*not in allowlist/.test(m))).toBe(true);
    // sessionRefresh logs both "Session refresh" and "Session refreshed" — verify it ran cleanly through both phases
    expect(logCalls.some(m => /Session refresh \(--continue restart\)/.test(m))).toBe(true);
    expect(logCalls.some(m => /Session refreshed/.test(m))).toBe(true);
  });

  it('agent ends in a clean stopped state after refused sessionRefresh', async () => {
    const ap = new AgentProcess(
      'refresh-clean',
      mockEnv,
      { runtime: 'unsupported-runtime' } as any,
    );

    await ap.sessionRefresh();

    // Neither half-running nor crashed — just cleanly stopped.
    expect(ap.getStatus().status).toBe('stopped');
  });
});
