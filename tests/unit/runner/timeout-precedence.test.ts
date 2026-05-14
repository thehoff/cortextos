/**
 * PR5 (MCP support) — per-tool timeout precedence chain
 * (PLAN §5.3, Codex pass-1 PR5-004 + pass-3 PR5-023).
 *
 * The chain, top wins:
 *   1. cfg.tool_timeouts_sec[qualifiedName] (per-call override at loop dispatch)
 *   2. server.tool_timeout_sec (per-MCP-server default in route.defaultTimeoutMs)
 *   3. cfg.mcp_tool_timeout_sec (global MCP default; passed in as
 *      bootMcpManager opts.defaultToolTimeoutMs by run-openai-agent.ts)
 *   4. cfg.tool_timeout_sec (global runner default — same code path)
 *   5. Hard 30s fallback (also computed in run-openai-agent.ts)
 *
 * Rungs 3-5 fuse into one number that the runner hands to the manager
 * as `defaultToolTimeoutMs`. This file pins:
 *   - rungs 1+2 at the dispatchMcpCall level
 *   - rung 2-vs-3 in the manager's route construction
 *   - the run-openai-agent fusion is covered indirectly by the existing
 *     runner-mcp-roundtrip integration test (a default of 30s wouldn't
 *     time out a fast echo, so any wiring error there surfaces in that
 *     test anyway).
 */
import { describe, it, expect, vi } from 'vitest';
import { join } from 'path';
import { bootMcpManager, dispatchMcpCall } from '../../../src/openai-runner/mcp/manager';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const TSX = join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const ECHO_FIXTURE = join(REPO_ROOT, 'tests', 'fixtures', 'mcp', 'server-echo.ts');

const BUILTIN_NAMES = new Set([
  'get_current_time', 'list_memory_files', 'read_memory_file',
  'kb_search', 'bus_log_event', 'bus_send_message',
]);

describe('MCP per-tool timeout precedence chain', { timeout: 30_000 }, () => {
  it('per-call (rung 1) wins over server (rung 2) when both are set', async () => {
    const manager = await bootMcpManager({
      specs: [{ name: 'srv', command: TSX, args: [ECHO_FIXTURE], tool_timeout_sec: 50 }],
      cwd: REPO_ROOT,
      bootTimeoutMs: 15_000,
      defaultToolTimeoutMs: 60_000,    // would-be rung-3 default
      builtinToolNames: BUILTIN_NAMES,
      runnerEnv: process.env,
    });
    try {
      const callSpy = vi.spyOn(manager.clients.get('srv')!, 'call');
      await dispatchMcpCall(manager, 'mcp__srv__echo', { text: 'x' }, 7_000);
      expect(callSpy).toHaveBeenCalledWith('echo', { text: 'x' }, 7_000, undefined);
    } finally {
      await manager.shutdown();
    }
  });

  it('server (rung 2) wins over default (rungs 3-5 fused) when no per-call override is set', async () => {
    const manager = await bootMcpManager({
      specs: [{ name: 'srv', command: TSX, args: [ECHO_FIXTURE], tool_timeout_sec: 22 }],
      cwd: REPO_ROOT,
      bootTimeoutMs: 15_000,
      defaultToolTimeoutMs: 99_999,    // would only surface without the server override
      builtinToolNames: BUILTIN_NAMES,
      runnerEnv: process.env,
    });
    try {
      const callSpy = vi.spyOn(manager.clients.get('srv')!, 'call');
      await dispatchMcpCall(manager, 'mcp__srv__echo', { text: 'y' }, undefined);
      expect(callSpy).toHaveBeenCalledWith('echo', { text: 'y' }, 22_000, undefined);
    } finally {
      await manager.shutdown();
    }
  });

  it('default (rungs 3-5 fused) surfaces when no server override is set and no per-call override is provided', async () => {
    const manager = await bootMcpManager({
      specs: [{ name: 'srv', command: TSX, args: [ECHO_FIXTURE] }],
      cwd: REPO_ROOT,
      bootTimeoutMs: 15_000,
      defaultToolTimeoutMs: 17_777,
      builtinToolNames: BUILTIN_NAMES,
      runnerEnv: process.env,
    });
    try {
      const callSpy = vi.spyOn(manager.clients.get('srv')!, 'call');
      await dispatchMcpCall(manager, 'mcp__srv__echo', { text: 'z' }, undefined);
      expect(callSpy).toHaveBeenCalledWith('echo', { text: 'z' }, 17_777, undefined);
    } finally {
      await manager.shutdown();
    }
  });

  it('per-call override (rung 1) wins over the default when no server override is set', async () => {
    const manager = await bootMcpManager({
      specs: [{ name: 'srv', command: TSX, args: [ECHO_FIXTURE] }],
      cwd: REPO_ROOT,
      bootTimeoutMs: 15_000,
      defaultToolTimeoutMs: 60_000,
      builtinToolNames: BUILTIN_NAMES,
      runnerEnv: process.env,
    });
    try {
      const callSpy = vi.spyOn(manager.clients.get('srv')!, 'call');
      await dispatchMcpCall(manager, 'mcp__srv__echo', { text: 'a' }, 3_000);
      expect(callSpy).toHaveBeenCalledWith('echo', { text: 'a' }, 3_000, undefined);
    } finally {
      await manager.shutdown();
    }
  });
});
