/**
 * PR3 (tool use): bus_log_event + bus_send_message safety.
 *
 * Both tools touch the live bus, so unit tests use real bus writes against
 * a tmp ctxRoot. PLAN.md pins:
 *   - bus_log_event: category forced to "action", max 10 events per turn.
 *   - bus_send_message: budget enforcement, recipient validation against
 *     enabled-agents.json, reply_to defaults to currentInboxMsgId, reply_to
 *     format validated.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { TOOL_REGISTRY } from '../../../src/openai-runner/tools/index';
import type { ToolContext } from '../../../src/openai-runner/tools/index';
import type { BusPaths } from '../../../src/types/index';

let tempDir: string;
let ctxRoot: string;

function makePaths(agent: string, org = 'acme'): BusPaths {
  return {
    ctxRoot,
    inbox: join(ctxRoot, 'inbox', agent),
    inflight: join(ctxRoot, 'inflight', agent),
    processed: join(ctxRoot, 'processed', agent),
    logDir: join(ctxRoot, 'logs', agent),
    stateDir: join(ctxRoot, 'state', agent),
    taskDir: join(ctxRoot, 'orgs', org, 'tasks'),
    approvalDir: join(ctxRoot, 'orgs', org, 'approvals'),
    analyticsDir: join(ctxRoot, 'orgs', org, 'analytics'),
    deliverablesDir: join(ctxRoot, 'orgs', org, 'deliverables'),
  };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'pr3-tool-bus-'));
  ctxRoot = join(tempDir, 'ctx');
  mkdirSync(ctxRoot, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const signal = new AbortController().signal;

describe('bus_log_event', () => {
  function makeCtx(): ToolContext {
    return {
      agentName: 'rag-1',
      agentDir: '/tmp/notused',
      paths: makePaths('rag-1'),
      org: 'acme',
      currentInboxMsgId: 'msg-1',
      sendBudget: { remaining: 3 },
      enabledAgentsRegistry: new Set(['rag-1']),
    };
  }

  it('writes a JSONL line with category=action', async () => {
    const ctx = makeCtx();
    const result = await TOOL_REGISTRY['bus_log_event']!.handler(
      { event: 'sub_task_started', severity: 'info', meta: { detail: 'x' } },
      ctx, signal,
    );
    expect(result).toBe('ok');

    const today = new Date().toISOString().split('T')[0];
    const eventDir = join(ctxRoot, 'orgs', 'acme', 'analytics', 'events', 'rag-1');
    const file = readdirSync(eventDir).find(f => f.startsWith(today));
    expect(file).toBeDefined();
    const entries = readFileSync(join(eventDir, file!), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    expect(entries[0].category).toBe('action');
    expect(entries[0].event).toBe('sub_task_started');
    expect(entries[0].metadata.detail).toBe('x');
  });

  it('rejects missing event name', async () => {
    const result = await TOOL_REGISTRY['bus_log_event']!.handler({}, makeCtx(), signal);
    expect(result.startsWith('error:')).toBe(true);
  });

  it('caps at 10 events per inbox message (same ctx)', async () => {
    const ctx = makeCtx();
    for (let i = 0; i < 10; i++) {
      const r = await TOOL_REGISTRY['bus_log_event']!.handler({ event: `e${i}` }, ctx, signal);
      expect(r).toBe('ok');
    }
    const r11 = await TOOL_REGISTRY['bus_log_event']!.handler({ event: 'e10' }, ctx, signal);
    expect(r11).toMatch(/budget exhausted/);
  });

  it('defaults severity to info if not provided', async () => {
    const result = await TOOL_REGISTRY['bus_log_event']!.handler({ event: 'just_event' }, makeCtx(), signal);
    expect(result).toBe('ok');
  });
});

describe('bus_send_message', () => {
  function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
    return {
      agentName: 'rag-1',
      agentDir: '/tmp/notused',
      paths: makePaths('rag-1'),
      org: 'acme',
      currentInboxMsgId: 'inbox-msg-1',
      sendBudget: { remaining: 3 },
      enabledAgentsRegistry: new Set(['rag-1', 'rag-2', 'analyst']),
      ...overrides,
    };
  }

  it('sends to an enabled agent and decrements the budget', async () => {
    const ctx = makeCtx();
    const r = await TOOL_REGISTRY['bus_send_message']!.handler(
      { to: 'rag-2', text: 'hello' },
      ctx, signal,
    );
    const parsed = JSON.parse(r);
    expect(parsed.ok).toBe(true);
    expect(parsed.remaining_budget).toBe(2);

    const inboxDir = join(ctxRoot, 'inbox', 'rag-2');
    const files = readdirSync(inboxDir).filter(f => f.endsWith('.json'));
    expect(files.length).toBe(1);
    const msg = JSON.parse(readFileSync(join(inboxDir, files[0]!), 'utf-8'));
    expect(msg.text).toBe('hello');
    expect(msg.from).toBe('rag-1');
    expect(msg.reply_to).toBe('inbox-msg-1');
  });

  it('rejects a non-enabled recipient', async () => {
    const r = await TOOL_REGISTRY['bus_send_message']!.handler(
      { to: 'ghost-agent', text: 'are you there' },
      makeCtx(), signal,
    );
    expect(r).toMatch(/not enabled/);
    // No message file should have been written.
    const ghostInbox = join(ctxRoot, 'inbox', 'ghost-agent');
    let files: string[] = [];
    try { files = readdirSync(ghostInbox); } catch { /* fine */ }
    expect(files.length).toBe(0);
  });

  it('rejects when budget is 0', async () => {
    const ctx = makeCtx({ sendBudget: { remaining: 0 } });
    const r = await TOOL_REGISTRY['bus_send_message']!.handler(
      { to: 'rag-2', text: 'hi' },
      ctx, signal,
    );
    expect(r).toMatch(/budget exhausted/);
  });

  it('uses custom reply_to if provided and valid', async () => {
    const r = await TOOL_REGISTRY['bus_send_message']!.handler(
      { to: 'rag-2', text: 'thread reply', reply_to: 'custom-reply-id-123' },
      makeCtx(), signal,
    );
    expect(JSON.parse(r).ok).toBe(true);

    const inboxDir = join(ctxRoot, 'inbox', 'rag-2');
    const file = readdirSync(inboxDir).filter(f => f.endsWith('.json'))[0]!;
    const msg = JSON.parse(readFileSync(join(inboxDir, file), 'utf-8'));
    expect(msg.reply_to).toBe('custom-reply-id-123');
  });

  it('rejects malformed reply_to format', async () => {
    const r = await TOOL_REGISTRY['bus_send_message']!.handler(
      { to: 'rag-2', text: 'x', reply_to: '../../etc/passwd' },
      makeCtx(), signal,
    );
    expect(r).toMatch(/invalid id format/);
  });

  it('respects priority parameter', async () => {
    const r = await TOOL_REGISTRY['bus_send_message']!.handler(
      { to: 'rag-2', text: 'urgent thing', priority: 'urgent' },
      makeCtx(), signal,
    );
    expect(JSON.parse(r).ok).toBe(true);

    const inboxDir = join(ctxRoot, 'inbox', 'rag-2');
    const file = readdirSync(inboxDir).filter(f => f.endsWith('.json'))[0]!;
    const msg = JSON.parse(readFileSync(join(inboxDir, file), 'utf-8'));
    expect(msg.priority).toBe('urgent');
  });

  it('defaults priority to normal when not supplied', async () => {
    const r = await TOOL_REGISTRY['bus_send_message']!.handler(
      { to: 'rag-2', text: 'x' },
      makeCtx(), signal,
    );
    expect(JSON.parse(r).ok).toBe(true);

    const inboxDir = join(ctxRoot, 'inbox', 'rag-2');
    const file = readdirSync(inboxDir).filter(f => f.endsWith('.json'))[0]!;
    const msg = JSON.parse(readFileSync(join(inboxDir, file), 'utf-8'));
    expect(msg.priority).toBe('normal');
  });
});
