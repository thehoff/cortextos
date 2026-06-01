/**
 * PR3 (tool use): kb_search caps + query-escape safety.
 *
 * The search tool scans the agent's memory + identity files for a literal
 * substring. PLAN.md pins:
 *   - regex special chars in the query auto-escaped
 *   - max 5 matches
 *   - max 200 chars per matched line (truncate)
 *   - max 4 KB total response
 *   - max 1 MB scanned per file
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { TOOL_REGISTRY } from '../../../src/openai-runner/tools/index';
import type { ToolContext } from '../../../src/openai-runner/tools/index';

let tempDir: string;
let agentDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'pr3-tool-kb-'));
  agentDir = join(tempDir, 'agent');
  mkdirSync(join(agentDir, 'memory'), { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makeCtx(): ToolContext {
  return {
    agentName: 'rag-1',
    agentDir,
    paths: {} as any,
    org: 'acme',
    currentInboxMsgId: 'msg-1',
    sendBudget: { remaining: 3 },
    enabledAgentsRegistry: new Set(),
  };
}

const signal = new AbortController().signal;

describe('kb_search', () => {
  it('returns file:line matches with excerpts', async () => {
    writeFileSync(join(agentDir, 'memory', 'log.md'), [
      '## Day 1',
      'Met Alice in the morning',
      'Worked on widgets',
      '## Day 2',
      'Bob called about widgets',
    ].join('\n'));

    const result = await TOOL_REGISTRY['kb_search']!.handler({ q: 'widgets' }, makeCtx(), signal);
    const parsed = JSON.parse(result);
    expect(parsed.matches.length).toBe(2);
    expect(parsed.matches[0]).toMatch(/log\.md:3/);
    expect(parsed.matches[1]).toMatch(/log\.md:5/);
  });

  it('escapes regex special chars in the query', async () => {
    writeFileSync(join(agentDir, 'memory', 'data.md'), 'config is (beta) v2.1');

    // A query of "(beta)" would blow up as a regex if not escaped (it would
    // match group-empty-string at every position).
    const result = await TOOL_REGISTRY['kb_search']!.handler({ q: '(beta)' }, makeCtx(), signal);
    const parsed = JSON.parse(result);
    expect(parsed.matches.length).toBe(1);
    expect(parsed.matches[0]).toContain('config is (beta) v2.1');
  });

  it('caps matches at 5', async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i} apple ${i}`);
    writeFileSync(join(agentDir, 'memory', 'fruit.md'), lines.join('\n'));

    const result = await TOOL_REGISTRY['kb_search']!.handler({ q: 'apple' }, makeCtx(), signal);
    const parsed = JSON.parse(result);
    expect(parsed.matches.length).toBe(5);
  });

  it('truncates long lines to 200 chars + ellipsis', async () => {
    const longLine = 'apple ' + 'x'.repeat(500);
    writeFileSync(join(agentDir, 'memory', 'long.md'), longLine);
    const result = await TOOL_REGISTRY['kb_search']!.handler({ q: 'apple' }, makeCtx(), signal);
    const parsed = JSON.parse(result);
    expect(parsed.matches[0]).toMatch(/\.\.\.$/);
    expect(parsed.matches[0]!.length).toBeLessThan(500);
  });

  it('searches IDENTITY.md and SYSTEM_PROMPT.md too', async () => {
    writeFileSync(join(agentDir, 'IDENTITY.md'), 'I am the unique identity sentinel.');
    writeFileSync(join(agentDir, 'SYSTEM_PROMPT.md'), 'Be sentinel-like in your answers.');

    const result = await TOOL_REGISTRY['kb_search']!.handler({ q: 'sentinel' }, makeCtx(), signal);
    const parsed = JSON.parse(result);
    const files = parsed.matches.map((m: string) => m.split(':')[0]);
    expect(files).toContain('IDENTITY.md');
    expect(files).toContain('SYSTEM_PROMPT.md');
  });

  it('returns empty matches when nothing matches', async () => {
    writeFileSync(join(agentDir, 'memory', 'notes.md'), 'apples and oranges');
    const result = await TOOL_REGISTRY['kb_search']!.handler({ q: 'pomegranate' }, makeCtx(), signal);
    const parsed = JSON.parse(result);
    expect(parsed.matches).toEqual([]);
  });

  it('rejects missing/empty query', async () => {
    const r1 = await TOOL_REGISTRY['kb_search']!.handler({}, makeCtx(), signal);
    const r2 = await TOOL_REGISTRY['kb_search']!.handler({ q: '   ' }, makeCtx(), signal);
    expect(r1.startsWith('error:')).toBe(true);
    expect(r2.startsWith('error:')).toBe(true);
  });

  it('is case-insensitive', async () => {
    writeFileSync(join(agentDir, 'memory', 'notes.md'), 'PARIS is a capital');
    const result = await TOOL_REGISTRY['kb_search']!.handler({ q: 'paris' }, makeCtx(), signal);
    const parsed = JSON.parse(result);
    expect(parsed.matches.length).toBe(1);
  });
});
