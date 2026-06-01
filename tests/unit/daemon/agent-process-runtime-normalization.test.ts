/**
 * PR1 (openai-compatible runtime): the dispatch-allowlist guard normalizes
 * a missing/null `runtime` field to 'claude-code' before checking the
 * allowlist.
 *
 * Why this matters: AgentConfig.runtime is OPTIONAL in src/types/index.ts;
 * legacy Claude agents on disk have NO runtime field (add-agent.ts only
 * writes it for non-default runtimes). A literal
 * `DISPATCH_ALLOWLIST.includes(config.runtime)` would evaluate
 * `.includes(undefined)` → false → rejected, breaking every existing Claude
 * agent fleet-wide on PR1 merge.
 *
 * The fix: `const runtime = this.config.runtime ?? 'claude-code'` before
 * the allowlist check. Preserves the pre-allowlist fall-through behaviour
 * of `agent-process.ts:117-121` (anything not Hermes/Codex → AgentPTY).
 *
 * Empty string ('') is deliberately NOT normalized — it's not a valid
 * value of the `AgentConfig.runtime` type union and should fail the
 * allowlist loudly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let capturedOnExit: ((exitCode: number, signal?: number) => void) | null = null;

const mockClaudePty = {
  spawn: vi.fn().mockResolvedValue(undefined),
  kill: vi.fn(),
  write: vi.fn(),
  getPid: vi.fn().mockReturnValue(12345),
  isAlive: vi.fn().mockReturnValue(true),
  onExit: vi.fn().mockImplementation((cb: (exitCode: number, signal?: number) => void) => {
    capturedOnExit = cb;
  }),
};

vi.mock('../../../src/pty/agent-pty.js', () => ({
  AgentPTY: function AgentPTY() { return mockClaudePty; },
}));

vi.mock('../../../src/pty/codex-app-server-pty.js', () => ({
  CodexAppServerPTY: function CodexAppServerPTY() { return {}; },
}));

vi.mock('../../../src/pty/hermes-pty.js', () => ({
  HermesPTY: function HermesPTY() { return {}; },
  hermesDbExists: vi.fn().mockReturnValue(false),
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
  agentName: 'legacy',
  agentDir: '/tmp/fw/orgs/acme/agents/legacy',
  org: 'acme',
  projectRoot: '/tmp/fw',
};

beforeEach(() => {
  capturedOnExit = null;
  mockClaudePty.spawn.mockClear();
});

describe('AgentProcess runtime normalization (?? "claude-code")', () => {
  it('runtime=undefined normalizes to claude-code and dispatches AgentPTY', async () => {
    // Legacy Claude agent: config.json has NO runtime field.
    const ap = new AgentProcess('legacy', mockEnv, {} as any);
    await ap.start();
    expect(mockClaudePty.spawn).toHaveBeenCalled();
  });

  it('runtime=null normalizes to claude-code and dispatches AgentPTY', async () => {
    // Defensive case: someone wrote `"runtime": null` into config.json.
    const ap = new AgentProcess('legacy', mockEnv, { runtime: null } as any);
    await ap.start();
    expect(mockClaudePty.spawn).toHaveBeenCalled();
  });

  it('runtime="claude-code" explicitly: same outcome as missing field', async () => {
    const ap = new AgentProcess('legacy', mockEnv, { runtime: 'claude-code' } as any);
    await ap.start();
    expect(mockClaudePty.spawn).toHaveBeenCalled();
  });
});
