/**
 * PR2 (openai-compatible runtime): runner's bus interactions round-trip.
 *
 * The v0 council prototype shells out to `cortextos bus *` because it lives
 * outside the cortextos repo. The PR2 port uses direct imports from
 * src/bus/index.ts — sendMessage, ackInbox, updateHeartbeat, logEvent.
 *
 * This test pins the runtime-agnostic contract: the runner's exact call
 * sequence (heartbeat 'idle' → log agent_online → heartbeat 'working' →
 * sendMessage reply → ackInbox → log task_completed → heartbeat 'idle')
 * produces the expected on-disk state when called directly, just like it
 * would when the council prototype shells out.
 *
 * Modelled on tests/integration/codex-bus-roundtrip.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { sendMessage, checkInbox, ackInbox } from '../../src/bus/message.js';
import { updateHeartbeat } from '../../src/bus/heartbeat.js';
import { logEvent } from '../../src/bus/event.js';
import type { BusPaths } from '../../src/types/index.js';

let testDir: string;
let ctxRoot: string;

function makePaths(agent: string, org = 'openai-org'): BusPaths {
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
  testDir = mkdtempSync(join(tmpdir(), 'openai-bus-roundtrip-'));
  ctxRoot = join(testDir, '.cortextos', 'test');
  mkdirSync(ctxRoot, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('openai-compatible runner bus round-trip', () => {
  it('full runner-style sequence: agent_online → reply → ack → task_completed', () => {
    const ragPaths = makePaths('rag-1');
    const userPaths = makePaths('human');

    // Boot-time announce. The runner emits these immediately after the
    // bootstrap signal so the dashboard sees the agent come alive.
    updateHeartbeat(ragPaths, 'rag-1', 'idle', { org: 'openai-org' });
    logEvent(ragPaths, 'rag-1', 'openai-org', 'milestone', 'agent_online', 'info', {
      agent: 'rag-1', model: 'lfm2-8b', endpoint: 'http://localhost:8080',
    });

    // Inbound: a human-facing agent sends a question.
    const msgId = sendMessage(userPaths, 'human', 'rag-1', 'normal', 'What is the capital of France?');

    // Runner picks up the message.
    const inbox = checkInbox(ragPaths);
    expect(inbox).toHaveLength(1);
    expect(inbox[0].id).toBe(msgId);
    expect(inbox[0].from).toBe('human');

    // Runner sets working status while it calls the LLM.
    updateHeartbeat(ragPaths, 'rag-1', 'working', { org: 'openai-org', currentTask: 'answering human' });

    // Runner sends the reply.
    sendMessage(ragPaths, 'rag-1', 'human', 'normal', 'Paris.', msgId);

    // Runner acks the inbox message.
    ackInbox(ragPaths, msgId);

    // Runner logs the completion + returns to idle.
    logEvent(ragPaths, 'rag-1', 'openai-org', 'task', 'task_completed', 'info', {
      answered: 'human', msg_id: msgId,
    });
    updateHeartbeat(ragPaths, 'rag-1', 'idle', { org: 'openai-org' });

    // Inbox state machine: processed/, inflight/, inbox/ all in the right state.
    expect(readdirSync(ragPaths.inbox).filter(f => f.endsWith('.json'))).toHaveLength(0);
    expect(readdirSync(ragPaths.inflight).filter(f => f.endsWith('.json'))).toHaveLength(0);
    expect(readdirSync(ragPaths.processed).filter(f => f.endsWith('.json'))).toHaveLength(1);

    // The human's inbox now contains the reply, threaded via reply_to.
    const humanInbox = checkInbox(userPaths);
    expect(humanInbox).toHaveLength(1);
    expect(humanInbox[0].from).toBe('rag-1');
    expect(humanInbox[0].text).toBe('Paris.');
    expect(humanInbox[0].reply_to).toBe(msgId);
  });

  it('emits task_completed and agent_online events as JSONL with the expected schema', () => {
    const paths = makePaths('rag-events');

    logEvent(paths, 'rag-events', 'openai-org', 'milestone', 'agent_online', 'info', {
      agent: 'rag-events', model: 'lfm2-8b', endpoint: 'http://localhost:8080',
    });
    logEvent(paths, 'rag-events', 'openai-org', 'task', 'task_completed', 'info', {
      answered: 'human', msg_id: '12345-human-abcde',
    });

    const today = new Date().toISOString().split('T')[0];
    const eventFile = join(paths.analyticsDir, 'events', 'rag-events', `${today}.jsonl`);
    const lines = readFileSync(eventFile, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(2);

    const events = lines.map(l => JSON.parse(l));
    expect(events[0].event).toBe('agent_online');
    expect(events[0].metadata.model).toBe('lfm2-8b');
    expect(events[0].metadata.endpoint).toBe('http://localhost:8080');
    expect(events[1].event).toBe('task_completed');
    expect(events[1].metadata.msg_id).toBe('12345-human-abcde');
  });

  it('heartbeat status writes through state/<agent>/heartbeat.json with current_task preserved', () => {
    const paths = makePaths('rag-hb');
    updateHeartbeat(paths, 'rag-hb', 'working', { org: 'openai-org', currentTask: 'answering analyst' });
    const hb = JSON.parse(readFileSync(join(paths.stateDir, 'heartbeat.json'), 'utf-8'));
    expect(hb.status).toBe('working');
    expect(hb.current_task).toBe('answering analyst');
    expect(hb.agent).toBe('rag-hb');
  });

  it('openai-compatible agent ↔ claude agent cross-runtime messaging works (bus is runtime-agnostic)', () => {
    const openaiPaths = makePaths('rag-x');
    const claudePaths = makePaths('claude-x');

    sendMessage(openaiPaths, 'rag-x', 'claude-x', 'normal', 'openai to claude');
    sendMessage(claudePaths, 'claude-x', 'rag-x', 'normal', 'claude to openai');

    expect(checkInbox(claudePaths)[0].from).toBe('rag-x');
    expect(checkInbox(openaiPaths)[0].from).toBe('claude-x');
  });
});
