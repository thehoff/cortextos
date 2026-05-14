/**
 * Per-resource async mutex for PR6 dashboard MCP-management routes.
 *
 * Codex pass-1 PR6-002 (HIGH): two concurrent dashboard requests against
 * the same scaffold directory or the same agent's config.json can race
 * — both pass existsSync, both write, one set of changes is lost. This
 * module serializes operations keyed on the resource path.
 *
 * Scope: in-process only. Two operators with separate dashboard sessions
 * still share the same Node process (Next.js server), so locks work
 * across users. The CLI does NOT share this lock; mixing CLI and
 * dashboard writes is operator-shaped behavior that the file-level
 * atomic-rename pattern handles in the worst case.
 *
 * Lock semantics:
 *   - Per key, callers queue. Each waits for the previous to resolve.
 *   - Locks always release, even if the body throws (try/finally).
 *   - Long-stuck operations don't block other keys (per-key queue).
 */

const queues = new Map<string, Promise<void>>();

/**
 * Run `fn` with exclusive access to `key`. Concurrent calls with the
 * same key serialize; calls with different keys run in parallel.
 *
 * Returns whatever `fn` returns. If `fn` throws, the lock releases
 * and the error propagates.
 */
export async function withMcpLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();

  let release!: () => void;
  const ours = new Promise<void>(resolve => { release = resolve; });
  queues.set(key, previous.then(() => ours));

  try {
    await previous;
    return await fn();
  } finally {
    release();
    // Clean up the map entry if we're the tail (last in queue) so a
    // long-running app doesn't accumulate dead Promise.resolve() entries.
    // The `===` check makes us a no-op if another caller has already
    // appended to the queue.
    queueMicrotask(() => {
      const current = queues.get(key);
      if (current === ours.then(() => undefined)) {
        queues.delete(key);
      }
    });
  }
}

/** Test helper — count of active locks; should return to 0 between tests. */
export function _activeLockCount(): number {
  return queues.size;
}
