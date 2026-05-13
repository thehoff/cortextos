/**
 * PR1 integration: even when both layers of "enabled" are bypassed —
 * `config.json enabled:true` AND `enabled-agents.json enabled:true` for
 * an openai-compatible agent — the dispatch-allowlist guard at the top of
 * AgentProcess.start() refuses to spawn a PTY.
 *
 * Why this matters: the bypass is real and reachable via
 *   cortextos start <agent>           src/cli/start.ts:157
 *     ↓ auto-registers enabled:true in enabled-agents.json
 *     ↓ sends IPC start-agent
 *   src/daemon/ipc-server.ts:596      routes to AgentManager.startAgent
 *     ↓
 *   src/daemon/agent-manager.ts:147   does NOT check config.enabled
 *     ↓
 *   AgentProcess.start()              ← guard fires HERE
 *
 * The dispatch-allowlist guard is the load-bearing reason PR1 is safe to
 * merge alone. If `enabled:false` were the only defense, this bypass would
 * let an openai-compatible agent dispatch through AgentPTY (Claude default)
 * and crash.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let capturedOnExit: ((exitCode: number, signal?: number) => void) | null = null;

const mockClaudePty = {
  spawn: vi.fn().mockResolvedValue(undefined),
  kill: vi.fn(),
  write: vi.fn(),
  getPid: vi.fn().mockReturnValue(99001),
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
  instanceId: 'pr1-bypass-test',
  ctxRoot: '/tmp/test-ctx',
  frameworkRoot: '/tmp/fw',
  agentName: 'rag-bypass',
  agentDir: '/tmp/fw/orgs/acme/agents/rag-bypass',
  org: 'acme',
  projectRoot: '/tmp/fw',
};

beforeEach(() => {
  capturedOnExit = null;
  mockClaudePty.spawn.mockClear();
});

describe('PR1 integration: cortextos start bypass refused by dispatch guard', () => {
  it('refuses openai-compatible dispatch even with config.json enabled:true (registry bypass simulation)', async () => {
    // Simulates the post-bypass state: both gates of "enabled" were
    // overridden by cortextos start's auto-register + IPC path. The agent
    // should STILL refuse to start because the guard is the third defense.
    const logCalls: string[] = [];
    const ap = new AgentProcess(
      'rag-bypass',
      mockEnv,
      { runtime: 'openai-compatible', enabled: true } as any,
      (msg) => logCalls.push(msg),
    );

    await ap.start();

    expect(mockClaudePty.spawn).not.toHaveBeenCalled();
    expect(ap.getStatus().status).toBe('stopped');
    expect(logCalls.some(m => /Refusing to dispatch.*openai-compatible.*not in allowlist/.test(m))).toBe(true);
  });

  it('the rejection is deterministic — calling start() three times produces three rejections, never a spawn', async () => {
    // Models the "user keeps trying" case: each cortextos start invocation
    // routes through the same guard.
    const logCalls: string[] = [];
    const ap = new AgentProcess(
      'rag-persistent',
      mockEnv,
      { runtime: 'openai-compatible', enabled: true } as any,
      (msg) => logCalls.push(msg),
    );

    await ap.start();
    await ap.start();
    await ap.start();

    expect(mockClaudePty.spawn).not.toHaveBeenCalled();
    const rejections = logCalls.filter(m => /Refusing to dispatch.*openai-compatible/.test(m));
    expect(rejections.length).toBe(3);
  });
});
