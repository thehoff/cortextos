/**
 * PR3 (tool use): runToolWithTimeout race + AbortSignal contract.
 *
 * Codex P3-1 (HIGH) pass-10: sync builtins block the event loop and can't
 * be preempted by the timeout. The bounded-read fixes in read-memory-file
 * and kb-search address the worst case (multi-MB files); cooperative
 * signal.aborted checks at file boundaries bound the worst case in
 * kb-search across many files. This test pins the async-handler timeout
 * contract directly: a handler that respects the signal stops; one that
 * ignores it gets its result discarded once the timeout fires.
 *
 * runToolWithTimeout is exported from loop.ts solely for this test.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { runToolWithTimeout } from '../../../src/openai-runner/loop';
import type { ToolContext, ToolDefinition } from '../../../src/openai-runner/tools/index';
import { TOOL_REGISTRY } from '../../../src/openai-runner/tools/index';

function makeCtx(): ToolContext {
  return {
    agentName: 'rag-t',
    agentDir: '/tmp/notused',
    paths: {} as any,
    org: 'acme',
    currentInboxMsgId: 'msg-1',
    sendBudget: { remaining: 3 },
    enabledAgentsRegistry: new Set(),
  };
}

// Install temporary test-only tool definitions in the registry. Restored
// in beforeEach for each test.
const ORIGINAL_REGISTRY = { ...TOOL_REGISTRY };

beforeEach(() => {
  for (const k of Object.keys(TOOL_REGISTRY)) {
    delete (TOOL_REGISTRY as any)[k];
  }
  for (const [k, v] of Object.entries(ORIGINAL_REGISTRY)) {
    (TOOL_REGISTRY as any)[k] = v;
  }
});

describe('runToolWithTimeout', () => {
  it('returns the handler result when it resolves within the timeout', async () => {
    (TOOL_REGISTRY as any)['fast'] = {
      name: 'fast', description: 'fast tool', parameters: { type: 'object' },
      handler: async () => 'quick result',
    } as ToolDefinition;
    const result = await runToolWithTimeout('fast', {}, makeCtx(), 1_000);
    expect(result).toBe('quick result');
  });

  it('throws timeout error when an async handler ignores the signal and runs past the deadline', async () => {
    (TOOL_REGISTRY as any)['slow'] = {
      name: 'slow', description: 'slow tool', parameters: { type: 'object' },
      handler: async (_args, _ctx, _signal) =>
        new Promise<string>(resolve => setTimeout(() => resolve('too late'), 1000)),
    } as ToolDefinition;
    await expect(runToolWithTimeout('slow', {}, makeCtx(), 100)).rejects.toThrow(/exceeded 100ms timeout/);
  });

  it('an async handler that respects the signal can shortcut early', async () => {
    let aborted = false;
    (TOOL_REGISTRY as any)['cooperative'] = {
      name: 'cooperative', description: 'cooperative tool', parameters: { type: 'object' },
      handler: async (_args, _ctx, signal) => new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted by signal'));
        });
        setTimeout(() => _resolve('never'), 5000);
      }),
    } as ToolDefinition;
    await expect(runToolWithTimeout('cooperative', {}, makeCtx(), 50)).rejects.toThrow();
    expect(aborted).toBe(true);
  });

  it('handler that returns an error string is treated as a normal result (not a throw)', async () => {
    (TOOL_REGISTRY as any)['returns_error'] = {
      name: 'returns_error', description: 'error tool', parameters: { type: 'object' },
      handler: async () => 'error: something went wrong',
    } as ToolDefinition;
    const result = await runToolWithTimeout('returns_error', {}, makeCtx(), 100);
    expect(result).toBe('error: something went wrong');
  });
});
