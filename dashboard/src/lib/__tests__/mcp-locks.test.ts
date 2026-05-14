/**
 * PR6 (MCP dashboard): unit tests for the per-resource mutex used by
 * scaffold + wire + unwire routes (Codex pass-1 PR6-002).
 *
 * Pins:
 *   - Same-key calls serialize.
 *   - Different-key calls run in parallel.
 *   - Locks release on throw (try/finally).
 *   - Long-running operations don't starve other keys.
 */
import { describe, it, expect } from 'vitest';
import { withMcpLock } from '../mcp-locks';

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('withMcpLock', () => {
  it('serializes calls with the same key', async () => {
    const order: number[] = [];
    const a = withMcpLock('shared', async () => {
      order.push(1); await delay(40); order.push(2);
    });
    const b = withMcpLock('shared', async () => {
      order.push(3); await delay(10); order.push(4);
    });
    await Promise.all([a, b]);
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it('does NOT serialize calls with different keys', async () => {
    const order: number[] = [];
    const a = withMcpLock('key-a', async () => {
      order.push(1); await delay(40); order.push(4);
    });
    const b = withMcpLock('key-b', async () => {
      await delay(10); order.push(2); await delay(10); order.push(3);
    });
    await Promise.all([a, b]);
    // a starts at t=0, b interleaves at t=10 and t=20, a finishes at t=40.
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it('returns the inner function result', async () => {
    const result = await withMcpLock('key', async () => 42);
    expect(result).toBe(42);
  });

  it('releases the lock even when the inner function throws', async () => {
    await expect(withMcpLock('throwing', async () => { throw new Error('boom'); }))
      .rejects.toThrow(/boom/);
    // Subsequent same-key call should run immediately, not be blocked.
    const start = Date.now();
    await withMcpLock('throwing', async () => undefined);
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('queues N callers in order', async () => {
    const order: number[] = [];
    const callers = [1, 2, 3, 4, 5].map(n =>
      withMcpLock('queue', async () => {
        order.push(n);
        await delay(5);
      }),
    );
    await Promise.all(callers);
    expect(order).toEqual([1, 2, 3, 4, 5]);
  });
});
