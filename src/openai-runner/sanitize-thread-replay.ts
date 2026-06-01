/**
 * Sanitizes a thread JSONL history before replaying it into the next LLM
 * call. The OpenAI Chat Completions API rejects `role:"tool"` messages
 * whose `tool_call_id` doesn't reference a prior assistant `tool_calls`
 * entry; it also rejects assistant `tool_calls` entries that lack matching
 * tool follow-ups. A corrupted (or partially-written) JSONL file could
 * otherwise produce a 400 from the API on every subsequent inbox message
 * with the same `[memory:]` header.
 *
 * Rules (matching PLAN.md PR3 Codex H2 fix):
 *   1. Drop any `role:"tool"` message that doesn't reference a prior
 *      assistant `tool_calls.id` in the same array.
 *   2. For each `role:"assistant"` message with `tool_calls`, every
 *      call id must have a corresponding `role:"tool"` follow-up. If
 *      missing, strip the `tool_calls` field (treat the message as a
 *      plain assistant content turn).
 *   3. After step 2, re-evaluate: any `role:"tool"` whose referenced
 *      assistant turn just lost its `tool_calls` becomes an orphan and
 *      is dropped.
 *
 * The implementation does steps 1 + 2 in two passes since they interact;
 * step 3 falls out of re-running step 1 after step 2.
 *
 * Self-healing: no JSONL rewrite. Each load re-sanitizes. Operators
 * never have to look at the file.
 */

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ThreadMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export function sanitizeForLlmReplay(history: ThreadMessage[]): ThreadMessage[] {
  // Pass 1: collect the set of valid tool_call_ids from each assistant
  // message that has matching follow-up tool messages.
  // Strategy: walk forward; for each assistant with tool_calls, find the
  // immediately-following tool messages (until the next non-tool message)
  // and check coverage. If any call id is uncovered, strip tool_calls
  // from that assistant turn.

  const cleaned: ThreadMessage[] = [];
  for (let i = 0; i < history.length; i++) {
    const msg = history[i]!;
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      // Find the contiguous run of tool messages that follow.
      const callIds = new Set(msg.tool_calls.map(c => c.id));
      const covered = new Set<string>();
      let j = i + 1;
      while (j < history.length && history[j]!.role === 'tool') {
        const tcid = history[j]!.tool_call_id;
        if (tcid && callIds.has(tcid)) {
          covered.add(tcid);
        }
        j++;
      }
      if (covered.size === callIds.size) {
        // Full coverage — keep the assistant turn and its tool replies.
        cleaned.push(msg);
        for (let k = i + 1; k < j; k++) {
          const tk = history[k]!;
          // Only keep tool messages whose tool_call_id matches one of THIS
          // assistant's call ids — extras (from misalignment) get dropped.
          if (tk.tool_call_id && callIds.has(tk.tool_call_id)) {
            cleaned.push(tk);
          }
        }
        i = j - 1;
      } else {
        // Partial coverage — strip tool_calls from the assistant turn and
        // drop all the follow-up tool messages.
        const { tool_calls: _stripped, ...rest } = msg;
        cleaned.push({ ...rest, content: rest.content ?? '' });
        i = j - 1;
      }
    } else if (msg.role === 'tool') {
      // Top-level orphan tool message (no preceding assistant with tool_calls
      // in this walk). Drop it.
      continue;
    } else {
      cleaned.push(msg);
    }
  }
  return cleaned;
}
