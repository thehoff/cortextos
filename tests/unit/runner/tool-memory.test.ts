/**
 * PR3 (tool use): list_memory_files + read_memory_file path safety.
 *
 * The memory tools touch the filesystem under the agent directory. Path-
 * traversal regressions here would let the model read arbitrary files on
 * the host. PLAN.md pins:
 *   - filename regex: ^[A-Za-z0-9][A-Za-z0-9._-]*\.(md|txt|json)$
 *   - NFC normalize before regex
 *   - file size cap 256 KB (truncation marker on overflow)
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
  tempDir = mkdtempSync(join(tmpdir(), 'pr3-tool-mem-'));
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

describe('list_memory_files', () => {
  it('lists files in memory/ directory', async () => {
    writeFileSync(join(agentDir, 'memory', 'a.md'), 'a');
    writeFileSync(join(agentDir, 'memory', 'b.md'), 'b');
    writeFileSync(join(agentDir, 'memory', '2026-05-13.md'), 'c');

    const result = await TOOL_REGISTRY['list_memory_files']!.handler({}, makeCtx(), signal);
    const parsed = JSON.parse(result);
    expect(parsed.files.sort()).toEqual(['2026-05-13.md', 'a.md', 'b.md']);
  });

  it('returns empty array when memory/ does not exist', async () => {
    rmSync(join(agentDir, 'memory'), { recursive: true });
    const result = await TOOL_REGISTRY['list_memory_files']!.handler({}, makeCtx(), signal);
    expect(JSON.parse(result)).toEqual({ files: [] });
  });

  it('does not include subdirectories', async () => {
    mkdirSync(join(agentDir, 'memory', 'subdir'));
    writeFileSync(join(agentDir, 'memory', 'top.md'), 'top');

    const result = await TOOL_REGISTRY['list_memory_files']!.handler({}, makeCtx(), signal);
    expect(JSON.parse(result).files).toEqual(['top.md']);
  });
});

describe('read_memory_file', () => {
  it('reads a valid file', async () => {
    writeFileSync(join(agentDir, 'memory', 'notes.md'), 'hello world');
    const result = await TOOL_REGISTRY['read_memory_file']!.handler({ name: 'notes.md' }, makeCtx(), signal);
    expect(result).toBe('hello world');
  });

  it.each([
    ['../etc/passwd'],
    ['/etc/passwd'],
    ['..'],
    ['.hidden.md'],            // leading dot — disallowed
    ['foo.exe'],               // wrong extension
    ['foo/bar.md'],            // path separator
    ['foo\\bar.md'],           // Windows separator
    [''],                      // empty
  ])('rejects path-traversal attempt: %s', async (name) => {
    const result = await TOOL_REGISTRY['read_memory_file']!.handler({ name }, makeCtx(), signal);
    expect(result.startsWith('error:')).toBe(true);
  });

  it('NFC-normalizes input before validating', async () => {
    // Unicode confusable: a fullwidth period (U+FF0E) in NFC normalizes to
    // ASCII "." in NFKC but stays distinct in NFC. The regex test happens
    // against NFC normalization, so a fullwidth period should still be
    // rejected because it isn't in the ASCII allowlist.
    writeFileSync(join(agentDir, 'memory', 'real.md'), 'real');
    const result = await TOOL_REGISTRY['read_memory_file']!.handler(
      { name: 'real．md' },  // "real．md" — fullwidth period
      makeCtx(),
      signal,
    );
    expect(result.startsWith('error:')).toBe(true);
  });

  it('returns error for ENOENT', async () => {
    const result = await TOOL_REGISTRY['read_memory_file']!.handler(
      { name: 'does-not-exist.md' }, makeCtx(), signal,
    );
    expect(result).toMatch(/not found/);
  });

  it('truncates files larger than 256 KB with a marker', async () => {
    const huge = 'x'.repeat(300 * 1024);
    writeFileSync(join(agentDir, 'memory', 'huge.md'), huge);
    const result = await TOOL_REGISTRY['read_memory_file']!.handler({ name: 'huge.md' }, makeCtx(), signal);
    expect(result.length).toBeLessThan(huge.length);
    expect(result).toMatch(/truncated/);
  });

  it('rejects missing or non-string name', async () => {
    const r1 = await TOOL_REGISTRY['read_memory_file']!.handler({}, makeCtx(), signal);
    const r2 = await TOOL_REGISTRY['read_memory_file']!.handler({ name: 42 }, makeCtx(), signal);
    expect(r1.startsWith('error:')).toBe(true);
    expect(r2.startsWith('error:')).toBe(true);
  });
});
