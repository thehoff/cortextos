import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { updateCronFire, readCronState, parseDurationMs, cronExpressionMinIntervalMs } from '../../../src/bus/cron-state';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cron-state-test-'));
});

function cleanup() {
  try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
}

describe('parseDurationMs', () => {
  it('parses minutes', () => {
    expect(parseDurationMs('30m')).toBe(30 * 60_000);
  });

  it('parses hours', () => {
    expect(parseDurationMs('6h')).toBe(6 * 3_600_000);
    expect(parseDurationMs('24h')).toBe(24 * 3_600_000);
  });

  it('parses days', () => {
    expect(parseDurationMs('1d')).toBe(86_400_000);
  });

  it('parses weeks', () => {
    expect(parseDurationMs('2w')).toBe(2 * 604_800_000);
  });

  it('returns NaN for cron expressions', () => {
    expect(parseDurationMs('0 8 * * *')).toBeNaN();
    expect(parseDurationMs('*/5 * * * *')).toBeNaN();
  });

  it('returns NaN for empty string', () => {
    expect(parseDurationMs('')).toBeNaN();
  });

  it('returns NaN for unknown unit', () => {
    expect(parseDurationMs('5y')).toBeNaN();
    expect(parseDurationMs('10s')).toBeNaN();
  });
});

describe('cronExpressionMinIntervalMs', () => {
  it('returns 24h for daily fixed-hour cron', () => {
    expect(cronExpressionMinIntervalMs('0 9 * * *')).toBe(24 * 3_600_000);
  });

  it('returns 7d for single-value DOW (weekly)', () => {
    expect(cronExpressionMinIntervalMs('0 9 * * 1')).toBe(7 * 24 * 3_600_000);
  });

  it('returns 28d for single-value DOM (monthly)', () => {
    expect(cronExpressionMinIntervalMs('0 9 1 * *')).toBe(28 * 24 * 3_600_000);
  });

  it('returns 24h for range DOW (e.g. weekdays)', () => {
    expect(cronExpressionMinIntervalMs('0 9 * * 1-5')).toBe(24 * 3_600_000);
  });

  it('returns 28d for combined DOM+DOW when DOW is range (AND semantics)', () => {
    expect(cronExpressionMinIntervalMs('0 9 1 * 1-5')).toBe(28 * 24 * 3_600_000);
  });

  it('returns 28d for combined DOM+DOW when DOM is range (AND semantics)', () => {
    expect(cronExpressionMinIntervalMs('0 9 1-5 * 1')).toBe(28 * 24 * 3_600_000);
  });

  it('returns 28d when both DOM and DOW are single-value (AND semantics)', () => {
    expect(cronExpressionMinIntervalMs('0 9 1 * 1')).toBe(28 * 24 * 3_600_000);
  });

  it('returns 24h for range DOM and no DOW restriction', () => {
    expect(cronExpressionMinIntervalMs('0 9 1-15 * *')).toBe(24 * 3_600_000);
  });

  it('returns 15min for */15 minute expression', () => {
    expect(cronExpressionMinIntervalMs('*/15 * * * *')).toBe(15 * 60_000);
  });

  it('returns 6h for every-N-hours expression', () => {
    expect(cronExpressionMinIntervalMs('0 */6 * * *')).toBe(6 * 3_600_000);
  });

  it('returns 48h fallback for out-of-range DOW (7)', () => {
    expect(cronExpressionMinIntervalMs('0 9 * * 7')).toBe(48 * 3_600_000);
  });

  it('returns 48h fallback for out-of-range DOM (0)', () => {
    expect(cronExpressionMinIntervalMs('0 9 0 * *')).toBe(48 * 3_600_000);
  });

  it('returns 48h fallback for out-of-range DOM (32)', () => {
    expect(cronExpressionMinIntervalMs('0 9 32 * *')).toBe(48 * 3_600_000);
  });

  // Steps/lists/ranges are conservative 24h — a too-short interval only makes
  // gap-nudges fire slightly early (never late), so the agent never misses a fire.
  it('returns 24h for step in DOW (e.g. */2)', () => {
    expect(cronExpressionMinIntervalMs('0 9 * * */2')).toBe(24 * 3_600_000);
  });

  it('returns 48h fallback for malformed expression', () => {
    expect(cronExpressionMinIntervalMs('bad')).toBe(48 * 3_600_000);
  });
});

describe('readCronState', () => {
  it('returns empty state when file does not exist', () => {
    const state = readCronState(tmpDir);
    expect(state.crons).toEqual([]);
    cleanup();
  });
});

describe('updateCronFire', () => {
  it('creates a record when none exists', () => {
    updateCronFire(tmpDir, 'heartbeat', '6h');
    const state = readCronState(tmpDir);
    expect(state.crons).toHaveLength(1);
    expect(state.crons[0].name).toBe('heartbeat');
    expect(state.crons[0].interval).toBe('6h');
    expect(Date.parse(state.crons[0].last_fire)).not.toBeNaN();
    cleanup();
  });

  it('updates existing record for the same cron name', () => {
    updateCronFire(tmpDir, 'heartbeat', '6h');
    const first = readCronState(tmpDir).crons[0].last_fire;

    // Ensure time advances
    const before = Date.now();
    updateCronFire(tmpDir, 'heartbeat', '6h');
    const second = readCronState(tmpDir).crons[0].last_fire;

    expect(Date.parse(second)).toBeGreaterThanOrEqual(before);
    expect(readCronState(tmpDir).crons).toHaveLength(1); // no duplicate
    cleanup();
  });

  it('accumulates records for different cron names', () => {
    updateCronFire(tmpDir, 'heartbeat', '6h');
    updateCronFire(tmpDir, 'autoresearch', '24h');
    const state = readCronState(tmpDir);
    expect(state.crons).toHaveLength(2);
    const names = state.crons.map(r => r.name);
    expect(names).toContain('heartbeat');
    expect(names).toContain('autoresearch');
    cleanup();
  });

  it('works without interval argument', () => {
    updateCronFire(tmpDir, 'heartbeat');
    const state = readCronState(tmpDir);
    expect(state.crons[0].name).toBe('heartbeat');
    expect(state.crons[0].interval).toBeUndefined();
    cleanup();
  });

  it('survives a read-write-read cycle with correct values', () => {
    updateCronFire(tmpDir, 'inbox-triage', '2h');
    updateCronFire(tmpDir, 'heartbeat', '4h');
    const state = readCronState(tmpDir);
    const inbox = state.crons.find(r => r.name === 'inbox-triage');
    const hb = state.crons.find(r => r.name === 'heartbeat');
    expect(inbox?.interval).toBe('2h');
    expect(hb?.interval).toBe('4h');
    cleanup();
  });
});
