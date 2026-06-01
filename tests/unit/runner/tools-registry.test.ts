/**
 * PR3 (tool use): registry hygiene + the trivial `get_current_time` tool.
 *
 * Every tool in the registry must satisfy the constraints the OpenAI
 * Chat Completions API enforces on the wire (name format, schema shape).
 * A regression where a new tool author breaks this would only surface as
 * an HTTP 400 mid-conversation, which is hard to debug. Pinning the
 * invariants in unit tests catches it before commit.
 */
import { describe, it, expect } from 'vitest';
import { TOOL_REGISTRY, buildToolsParameter } from '../../../src/openai-runner/tools/index';
import type { ToolContext } from '../../../src/openai-runner/tools/index';

const TOOL_NAME_RE = /^[a-z_][a-z0-9_]*$/;

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    agentName: 'rag-1',
    agentDir: '/tmp/agent',
    paths: {} as any,
    org: 'acme',
    currentInboxMsgId: 'msg-1',
    sendBudget: { remaining: 3 },
    enabledAgentsRegistry: new Set(['rag-1']),
    ...overrides,
  };
}

describe('PR3 tool registry hygiene', () => {
  it('every tool has a name matching ^[a-z_][a-z0-9_]*$', () => {
    for (const [key, tool] of Object.entries(TOOL_REGISTRY)) {
      expect(tool.name, `key/name mismatch for ${key}`).toBe(key);
      expect(tool.name, `bad name format: ${tool.name}`).toMatch(TOOL_NAME_RE);
    }
  });

  it('every tool has a non-empty description and a JSON-Schema-shaped parameters object', () => {
    for (const tool of Object.values(TOOL_REGISTRY)) {
      expect(tool.description.length, `${tool.name}: empty description`).toBeGreaterThan(0);
      const params = tool.parameters as Record<string, unknown>;
      expect(params['type'], `${tool.name}: parameters.type should be "object"`).toBe('object');
      expect(params['properties'], `${tool.name}: parameters.properties missing`).toBeDefined();
    }
  });

  it('every tool exposes a callable async handler', () => {
    for (const tool of Object.values(TOOL_REGISTRY)) {
      expect(typeof tool.handler, `${tool.name}: handler must be a function`).toBe('function');
      // The handler signature is enforced by TypeScript (args, ctx, signal);
      // we can't assert Function.length because handlers that don't use
      // their args/ctx/signal legitimately destructure to length 0.
    }
  });

  it('exposes exactly the six PR3 v1 builtins', () => {
    const names = Object.keys(TOOL_REGISTRY).sort();
    expect(names).toEqual([
      'bus_log_event',
      'bus_send_message',
      'get_current_time',
      'kb_search',
      'list_memory_files',
      'read_memory_file',
    ]);
  });

  it('buildToolsParameter emits the OpenAI wire shape for selected names', () => {
    const tools = buildToolsParameter(['get_current_time', 'kb_search']);
    expect(tools.length).toBe(2);
    for (const t of tools) {
      expect(t.type).toBe('function');
      expect(typeof t.function.name).toBe('string');
      expect(typeof t.function.description).toBe('string');
      expect(t.function.parameters).toBeDefined();
    }
  });
});

describe('get_current_time tool', () => {
  it('returns ISO 8601 UTC + timezone', async () => {
    const result = await TOOL_REGISTRY['get_current_time']!.handler(
      {}, makeCtx(), new AbortController().signal,
    );
    const parsed = JSON.parse(result);
    expect(parsed.utc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(typeof parsed.timezone).toBe('string');
  });

  it('honors CTX_TIMEZONE if set', async () => {
    const originalTz = process.env.CTX_TIMEZONE;
    process.env.CTX_TIMEZONE = 'Australia/Sydney';
    try {
      const result = await TOOL_REGISTRY['get_current_time']!.handler(
        {}, makeCtx(), new AbortController().signal,
      );
      const parsed = JSON.parse(result);
      expect(parsed.timezone).toBe('Australia/Sydney');
    } finally {
      if (originalTz === undefined) delete process.env.CTX_TIMEZONE;
      else process.env.CTX_TIMEZONE = originalTz;
    }
  });
});
