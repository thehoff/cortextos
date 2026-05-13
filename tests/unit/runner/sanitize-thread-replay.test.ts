/**
 * PR3 (tool use): sanitizeForLlmReplay() drops orphan tool messages and
 * un-fits assistant tool_calls that lack follow-ups.
 *
 * Codex H2 (pass 8) pinned: corrupted JSONL must not produce an invalid
 * OpenAI request. Self-healing on every load.
 */
import { describe, it, expect } from 'vitest';
import { sanitizeForLlmReplay } from '../../../src/openai-runner/sanitize-thread-replay';
import type { ThreadMessage } from '../../../src/openai-runner/sanitize-thread-replay';

describe('sanitizeForLlmReplay', () => {
  it('passes PR2-era logs (no tool fields) through unchanged', () => {
    const history: ThreadMessage[] = [
      { role: 'user', content: 'What is the capital of Japan?' },
      { role: 'assistant', content: 'Tokyo.' },
      { role: 'user', content: 'Its population?' },
      { role: 'assistant', content: 'About 37 million.' },
    ];
    expect(sanitizeForLlmReplay(history)).toEqual(history);
  });

  it('keeps a well-formed assistant→tool→assistant sequence', () => {
    const history: ThreadMessage[] = [
      { role: 'user', content: 'find alice in memory' },
      { role: 'assistant', content: null, tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'kb_search', arguments: '{"q":"alice"}' } },
      ]},
      { role: 'tool', tool_call_id: 'c1', content: 'memory/x.md:3 — Alice was here' },
      { role: 'assistant', content: 'Alice was at memory/x.md:3.' },
    ];
    expect(sanitizeForLlmReplay(history)).toEqual(history);
  });

  it('drops a top-level orphan tool message (no preceding assistant tool_calls)', () => {
    const history: ThreadMessage[] = [
      { role: 'user', content: 'q' },
      { role: 'tool', tool_call_id: 'phantom', content: 'orphan' },
      { role: 'assistant', content: 'a' },
    ];
    const result = sanitizeForLlmReplay(history);
    expect(result).toEqual([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
    ]);
  });

  it('strips tool_calls from assistant when matching tool follow-ups are missing', () => {
    const history: ThreadMessage[] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'pre-call thought', tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'kb_search', arguments: '{}' } },
      ]},
      // tool response missing — JSONL was truncated mid-write
      { role: 'user', content: 'next inbox message' },
    ];
    const result = sanitizeForLlmReplay(history);
    expect(result[0]).toEqual({ role: 'user', content: 'q' });
    // The assistant message keeps content but loses tool_calls.
    expect(result[1]?.role).toBe('assistant');
    expect(result[1]?.content).toBe('pre-call thought');
    expect(result[1]?.tool_calls).toBeUndefined();
    expect(result[2]).toEqual({ role: 'user', content: 'next inbox message' });
  });

  it('handles multi-call assistant turns — all tool ids must be covered', () => {
    const history: ThreadMessage[] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: null, tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'kb_search', arguments: '{}' } },
        { id: 'c2', type: 'function', function: { name: 'get_current_time', arguments: '{}' } },
      ]},
      { role: 'tool', tool_call_id: 'c1', content: 'r1' },
      { role: 'tool', tool_call_id: 'c2', content: 'r2' },
      { role: 'assistant', content: 'done' },
    ];
    expect(sanitizeForLlmReplay(history)).toEqual(history);
  });

  it('strips tool_calls if a multi-call assistant has only PARTIAL follow-ups', () => {
    const history: ThreadMessage[] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'mid', tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'kb_search', arguments: '{}' } },
        { id: 'c2', type: 'function', function: { name: 'get_current_time', arguments: '{}' } },
      ]},
      { role: 'tool', tool_call_id: 'c1', content: 'r1' },
      // c2 missing
      { role: 'user', content: 'next' },
    ];
    const result = sanitizeForLlmReplay(history);
    // The assistant turn loses tool_calls; tool message for c1 also dropped
    // (since the parent assistant no longer has tool_calls).
    expect(result.find(m => m.role === 'tool')).toBeUndefined();
    const asst = result.find(m => m.role === 'assistant' && m.content === 'mid');
    expect(asst).toBeDefined();
    expect(asst?.tool_calls).toBeUndefined();
  });
});
