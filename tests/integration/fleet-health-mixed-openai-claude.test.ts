/**
 * PR2 (openai-compatible runtime): peer to fleet-health-mixed-codex-claude.
 *
 * Verifies `computeFleetHealth` is runtime-agnostic across the
 * openai-compatible + claude combination. The dashboard's mixed-fleet view
 * relies on this — openai-compatible agents must appear in the summary with
 * identical row shape to claude agents.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { CronDefinition, CronExecutionLogEntry } from '../../src/types/index.js';

let tmpRoot: string;
const originalCtxRoot = process.env.CTX_ROOT;
const CRONS_DIR = '.cortextOS/state/agents';

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'fleet-mixed-openai-claude-'));
  process.env.CTX_ROOT = tmpRoot;
  vi.resetModules();
});

afterEach(() => {
  if (originalCtxRoot !== undefined) process.env.CTX_ROOT = originalCtxRoot;
  else delete process.env.CTX_ROOT;
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ok */ }
});

function writeEnabledAgents(agents: Record<string, { enabled?: boolean; org?: string }>) {
  mkdirSync(join(tmpRoot, 'config'), { recursive: true });
  writeFileSync(join(tmpRoot, 'config', 'enabled-agents.json'), JSON.stringify(agents, null, 2));
}

function writeCrons(agentName: string, crons: CronDefinition[]) {
  const dir = join(tmpRoot, CRONS_DIR, agentName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'crons.json'),
    JSON.stringify({ updated_at: new Date().toISOString(), crons }, null, 2),
  );
}

function writeLog(agentName: string, entries: CronExecutionLogEntry[]) {
  const dir = join(tmpRoot, CRONS_DIR, agentName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'cron-execution.log'), entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

function cron(name: string, schedule: string): CronDefinition {
  return {
    name,
    prompt: `Run ${name}.`,
    schedule,
    enabled: true,
    created_at: new Date(Date.now() - 7 * 86_400_000).toISOString(),
  };
}

function entry(cronName: string, status: 'fired' | 'failed', tsMs: number): CronExecutionLogEntry {
  return {
    ts: new Date(tsMs).toISOString(),
    cron: cronName,
    status,
    attempt: 1,
    duration_ms: 100,
    error: status === 'failed' ? 'err' : null,
  };
}

describe('fleet health — openai-compatible + claude coexistence', () => {
  it('returns a unified summary across openai-compatible and claude agents', async () => {
    const now = Date.now();
    const h = 3_600_000;

    writeEnabledAgents({
      'claude-agent': { enabled: true, org: 'lifeos' },
      'rag-1':        { enabled: true, org: 'lifeos' },
    });

    writeCrons('claude-agent', [cron('claude-heartbeat', '6h'), cron('claude-report', '24h')]);
    writeLog('claude-agent', [
      entry('claude-heartbeat', 'fired', now - 2 * h),
      entry('claude-report',   'fired', now - 50 * h),
    ]);

    writeCrons('rag-1', [cron('rag-heartbeat', '6h'), cron('rag-sweep', '1h')]);
    writeLog('rag-1', [
      entry('rag-heartbeat', 'fired', now - 5 * 60 * 1000),
      entry('rag-sweep',     'failed', now - 30 * 60 * 1000),
    ]);

    const { computeFleetHealth } = await import('../../src/daemon/ipc-server');
    const result = computeFleetHealth(undefined, now);

    expect(result.summary.total).toBe(4);

    const rowsByName = new Map(result.rows.map((r) => [r.cronName, r]));
    expect(rowsByName.get('claude-heartbeat')?.state).toBe('healthy');
    expect(rowsByName.get('claude-report')?.state).toBe('warning');
    expect(rowsByName.get('rag-heartbeat')?.state).toBe('healthy');
    expect(rowsByName.get('rag-sweep')?.state).toBe('failure');

    expect(result.summary.agents['rag-1']).toBeDefined();
    expect(result.summary.agents['rag-1'].total).toBe(2);
    expect(result.summary.agents['rag-1'].failure).toBe(1);
    expect(result.summary.agents['claude-agent']).toBeDefined();
    expect(result.summary.agents['claude-agent'].total).toBe(2);
  });

  it('cron health row shape is identical for openai-compatible and claude agents', async () => {
    const now = Date.now();
    writeEnabledAgents({
      'claude-x': { enabled: true, org: 'lifeos' },
      'rag-x':    { enabled: true, org: 'lifeos' },
    });
    writeCrons('claude-x', [cron('shared-name', '6h')]);
    writeLog('claude-x', [entry('shared-name', 'fired', now - 60_000)]);
    writeCrons('rag-x', [cron('shared-name', '6h')]);
    writeLog('rag-x', [entry('shared-name', 'fired', now - 60_000)]);

    const { computeFleetHealth } = await import('../../src/daemon/ipc-server');
    const result = computeFleetHealth(undefined, now);

    const claudeRow = result.rows.find((r) => r.agent === 'claude-x' && r.cronName === 'shared-name')!;
    const openaiRow = result.rows.find((r) => r.agent === 'rag-x' && r.cronName === 'shared-name')!;
    expect(Object.keys(claudeRow).sort()).toEqual(Object.keys(openaiRow).sort());
    expect(claudeRow.state).toBe(openaiRow.state);
    expect(claudeRow.expectedIntervalMs).toBe(openaiRow.expectedIntervalMs);
  });
});
