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
  // Capture the chained promise we put in the map so the cleanup
  // step can compare against the SAME reference. Codex pass-2 PR6-015:
  // the previous implementation re-evaluated `ours.then(...)` in the
  // cleanup, which always created a fresh Promise — the identity check
  // never matched and the map entry was never freed (memory leak).
  const ourChained = previous.then(() => ours);
  queues.set(key, ourChained);

  try {
    await previous;
    return await fn();
  } finally {
    release();
    queueMicrotask(() => {
      if (queues.get(key) === ourChained) {
        queues.delete(key);
      }
    });
  }
}

/** Test helper — count of active locks; should return to 0 between tests. */
export function _activeLockCount(): number {
  return queues.size;
}
