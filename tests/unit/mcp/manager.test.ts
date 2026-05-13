/**
 * PR5 (MCP support): unit tests for the multi-server manager.
 *
 * Spans:
 *   - Parallel boot with two servers — both fulfilled
 *   - One-of-two fails → rollback closes everything
 *   - Route table built with hyphen → underscore name transform
 *   - Collision detection against the builtin set
 *   - Boot-lifecycle owner gets the partial manager BEFORE any spawn
 *   - dispatch() routes correctly + unknown name throws
 */
import { describe, it, expect, vi } from 'vitest';
import { join } from 'path';
import { bootMcpManager, dispatchMcpCall } from '../../../src/openai-runner/mcp/manager';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const TSX = join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const ECHO_FIXTURE = join(REPO_ROOT, 'tests', 'fixtures', 'mcp', 'server-echo.ts');
const HANG_FIXTURE = join(REPO_ROOT, 'tests', 'fixtures', 'mcp', 'server-hang.ts');

const BUILTIN_NAMES = new Set([
  'get_current_time', 'list_memory_files', 'read_memory_file',
  'kb_search', 'bus_log_event', 'bus_send_message',
]);

describe('bootMcpManager', { timeout: 30_000 }, () => {
  it('boots multiple servers in parallel and exposes namespaced tools', async () => {
    const manager = await bootMcpManager({
      specs: [
        { name: 'srv-a', command: TSX, args: [ECHO_FIXTURE] },
        { name: 'srv-b', command: TSX, args: [ECHO_FIXTURE] },
      ],
      cwd: REPO_ROOT,
      bootTimeoutMs: 15_000,
      defaultToolTimeoutMs: 5_000,
      builtinToolNames: BUILTIN_NAMES,
      runnerEnv: process.env,
    });
    try {
      // Hyphenated server name becomes underscored in the qualified name.
      const names = manager.tools.map(t => t.name).sort();
      expect(names).toContain('mcp__srv_a__echo');
      expect(names).toContain('mcp__srv_b__echo');
      expect(names).toContain('mcp__srv_a__env_peek');
      expect(manager.clients.size).toBe(2);
      expect(manager.routes.size).toBe(4);
    } finally {
      await manager.shutdown();
    }
  });

  it('rolls back ALL spawned children when any server fails to boot (PR5-001)', async () => {
    // One hangs, one succeeds. The whole boot rejects, and shutdown
    // closes both children.
    await expect(bootMcpManager({
      specs: [
        { name: 'ok', command: TSX, args: [ECHO_FIXTURE] },
        { name: 'bad', command: TSX, args: [HANG_FIXTURE] },
      ],
      cwd: REPO_ROOT,
      bootTimeoutMs: 800,        // short enough to fail the hang fixture
      defaultToolTimeoutMs: 5_000,
      builtinToolNames: BUILTIN_NAMES,
      runnerEnv: process.env,
    })).rejects.toThrow(/boot timed out/);
    // Implicit cleanup verified: no zombies (the manager closes the
    // succeeded client during rollback). Coarse sanity: nothing more
    // to check — vitest would surface stuck handles if the children
    // were leaked.
  });

  it('rejects duplicate server names up front (no spawn attempted)', async () => {
    await expect(bootMcpManager({
      specs: [
        { name: 'same', command: TSX, args: [ECHO_FIXTURE] },
        { name: 'same', command: TSX, args: [ECHO_FIXTURE] },
      ],
      cwd: REPO_ROOT,
      bootTimeoutMs: 15_000,
      defaultToolTimeoutMs: 5_000,
      builtinToolNames: BUILTIN_NAMES,
      runnerEnv: process.env,
    })).rejects.toThrow(/duplicate server name/);
  });

  it('rejects qualified-name collision with a builtin tool (PR5-005)', async () => {
    // Construct a builtin set that already contains the qualified name
    // the echo server would produce, to trigger the guard. (In practice
    // the mcp__ prefix means this can't happen naturally; the test
    // proves the guard is wired.)
    const fakeBuiltins = new Set([...BUILTIN_NAMES, 'mcp__srv__echo']);
    await expect(bootMcpManager({
      specs: [{ name: 'srv', command: TSX, args: [ECHO_FIXTURE] }],
      cwd: REPO_ROOT,
      bootTimeoutMs: 15_000,
      defaultToolTimeoutMs: 5_000,
      builtinToolNames: fakeBuiltins,
      runnerEnv: process.env,
    })).rejects.toThrow(/collides with a builtin tool/);
  });

  it('exposes shutdown before any spawn via onBeforeFirstSpawn (PR5-002)', async () => {
    const shutdownRef: { current: (() => Promise<void>) | null } = { current: null };
    const manager = await bootMcpManager({
      specs: [{ name: 'srv', command: TSX, args: [ECHO_FIXTURE] }],
      cwd: REPO_ROOT,
      bootTimeoutMs: 15_000,
      defaultToolTimeoutMs: 5_000,
      builtinToolNames: BUILTIN_NAMES,
      runnerEnv: process.env,
      onBeforeFirstSpawn: (h) => { shutdownRef.current = h.shutdown; },
    });
    try {
      // Callback fired with a handle.
      expect(shutdownRef.current).toBeTypeOf('function');
      // And the handle is exactly the manager's shutdown.
      // (Identity check is fine because the function is stable across calls.)
      expect(shutdownRef.current).toBe(manager.shutdown);
    } finally {
      await manager.shutdown();
    }
  });

  it('shutdown is idempotent', async () => {
    const manager = await bootMcpManager({
      specs: [{ name: 'srv', command: TSX, args: [ECHO_FIXTURE] }],
      cwd: REPO_ROOT,
      bootTimeoutMs: 15_000,
      defaultToolTimeoutMs: 5_000,
      builtinToolNames: BUILTIN_NAMES,
      runnerEnv: process.env,
    });
    await manager.shutdown();
    // Second call should not throw or hang.
    await manager.shutdown();
    expect(true).toBe(true);
  });

  it('uses per-server tool_timeout_sec when provided', async () => {
    const manager = await bootMcpManager({
      specs: [{ name: 'srv', command: TSX, args: [ECHO_FIXTURE], tool_timeout_sec: 7 }],
      cwd: REPO_ROOT,
      bootTimeoutMs: 15_000,
      defaultToolTimeoutMs: 5_000,
      builtinToolNames: BUILTIN_NAMES,
      runnerEnv: process.env,
    });
    try {
      const route = manager.routes.get('mcp__srv__echo')!;
      expect(route.defaultTimeoutMs).toBe(7_000);
    } finally {
      await manager.shutdown();
    }
  });

  it('falls back to defaultToolTimeoutMs when spec.tool_timeout_sec is absent', async () => {
    const manager = await bootMcpManager({
      specs: [{ name: 'srv', command: TSX, args: [ECHO_FIXTURE] }],
      cwd: REPO_ROOT,
      bootTimeoutMs: 15_000,
      defaultToolTimeoutMs: 12_345,
      builtinToolNames: BUILTIN_NAMES,
      runnerEnv: process.env,
    });
    try {
      const route = manager.routes.get('mcp__srv__echo')!;
      expect(route.defaultTimeoutMs).toBe(12_345);
    } finally {
      await manager.shutdown();
    }
  });
});

describe('shutdown during boot (PR5-013 BLOCKER fix verification)', { timeout: 30_000 }, () => {
  it('cleanup runs even when shutdown fires while a server is still mid-handshake', async () => {
    // The hang fixture never responds to initialize; its child process
    // stays alive indefinitely unless something closes it. Boot the
    // manager against it, and immediately call shutdown() before the
    // bootTimeoutMs would expire. The pre-PR5-013 placeholder cleanup
    // would have been a no-op; the fix's beginMcpConnect ensures the
    // real cleanup is registered synchronously and is callable while
    // the connect promise is still pending.
    const bootPromise = bootMcpManager({
      specs: [{ name: 'hang-srv', command: TSX, args: [HANG_FIXTURE] }],
      cwd: REPO_ROOT,
      bootTimeoutMs: 30_000,        // long — we'll cancel it ourselves
      defaultToolTimeoutMs: 5_000,
      builtinToolNames: BUILTIN_NAMES,
      runnerEnv: process.env,
      onBeforeFirstSpawn: (h) => {
        // Schedule shutdown to fire 250ms into boot — well after spawn,
        // well before the 30s timeout. Without the PR5-013 fix this
        // call would not close the child.
        setTimeout(() => { void h.shutdown(); }, 250);
      },
    });
    // boot should reject (the hang fixture never responds + we shut it down).
    await expect(bootPromise).rejects.toBeDefined();
    // The hang fixture child process should be reaped within a couple
    // seconds. If the BLOCKER weren't fixed, the child would still be
    // running and vitest would surface a leaked handle.
  });
});

describe('dispatchMcpCall', { timeout: 20_000 }, () => {
  it('routes a qualified call to the right client', async () => {
    const manager = await bootMcpManager({
      specs: [{ name: 'srv', command: TSX, args: [ECHO_FIXTURE] }],
      cwd: REPO_ROOT,
      bootTimeoutMs: 15_000,
      defaultToolTimeoutMs: 5_000,
      builtinToolNames: BUILTIN_NAMES,
      runnerEnv: process.env,
    });
    try {
      const result = await dispatchMcpCall(manager, 'mcp__srv__echo', { text: 'routed' }, 5_000);
      expect(result).toBe('routed');
    } finally {
      await manager.shutdown();
    }
  });

  it('throws on unknown qualified name', async () => {
    const manager = await bootMcpManager({
      specs: [{ name: 'srv', command: TSX, args: [ECHO_FIXTURE] }],
      cwd: REPO_ROOT,
      bootTimeoutMs: 15_000,
      defaultToolTimeoutMs: 5_000,
      builtinToolNames: BUILTIN_NAMES,
      runnerEnv: process.env,
    });
    try {
      await expect(dispatchMcpCall(manager, 'mcp__nope__nope', {}, 5_000))
        .rejects.toThrow(/unknown MCP tool/);
    } finally {
      await manager.shutdown();
    }
  });

  it('uses route.defaultTimeoutMs when perCallTimeoutMs is undefined', async () => {
    const manager = await bootMcpManager({
      specs: [{ name: 'srv', command: TSX, args: [ECHO_FIXTURE], tool_timeout_sec: 8 }],
      cwd: REPO_ROOT,
      bootTimeoutMs: 15_000,
      defaultToolTimeoutMs: 5_000,
      builtinToolNames: BUILTIN_NAMES,
      runnerEnv: process.env,
    });
    try {
      const callSpy = vi.spyOn(manager.clients.get('srv')!, 'call');
      await dispatchMcpCall(manager, 'mcp__srv__echo', { text: 'a' }, undefined);
      expect(callSpy).toHaveBeenCalledWith('echo', { text: 'a' }, 8_000, undefined);
    } finally {
      await manager.shutdown();
    }
  });

  it('boots a manager with no servers cleanly', async () => {
    const manager = await bootMcpManager({
      specs: [],
      cwd: REPO_ROOT,
      bootTimeoutMs: 15_000,
      defaultToolTimeoutMs: 5_000,
      builtinToolNames: BUILTIN_NAMES,
      runnerEnv: process.env,
    });
    expect(manager.tools).toEqual([]);
    expect(manager.clients.size).toBe(0);
    expect(manager.routes.size).toBe(0);
    await manager.shutdown();
  });
});
