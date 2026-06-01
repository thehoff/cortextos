/**
 * Daemon-side cron fire timestamp registry (cron-state.json).
 *
 * Solves the dead zone problem (issue #67): context compression silently drops
 * in-session CronCreate schedules. This module records when each named cron
 * last fired in a file that survives all restarts. AgentProcess polls the file
 * and injects a gap-nudge when a cron has been silent for >2x its interval.
 *
 * Lifecycle:
 *   1. Agent calls `cortextos bus update-cron-fire <name> --interval <interval>`
 *      at the end of each cron prompt execution.
 *   2. Daemon gap-detection loop reads cron-state.json every 10 minutes.
 *   3. If last_fire is >2x interval ago, daemon injects a nudge into the agent PTY.
 *
 * Storage: state/<agent>/cron-state.json (same dir as pending-reminders.json).
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ensureDir } from '../utils/atomic.js';

export interface CronFireRecord {
  name: string;
  last_fire: string;   // ISO 8601 UTC
  interval?: string;   // e.g. "6h", "24h", "30m" — copied from update call
}

interface CronStateFile {
  updated_at: string;
  crons: CronFireRecord[];
}

function cronStatePath(stateDir: string): string {
  return join(stateDir, 'cron-state.json');
}

export function readCronState(stateDir: string): CronStateFile {
  const filePath = cronStatePath(stateDir);
  if (!existsSync(filePath)) {
    return { updated_at: new Date().toISOString(), crons: [] };
  }
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && Array.isArray(parsed.crons)
      ? parsed
      : { updated_at: new Date().toISOString(), crons: [] };
  } catch {
    return { updated_at: new Date().toISOString(), crons: [] };
  }
}

/**
 * Record that a cron just fired. Creates or updates the entry for `cronName`.
 * Called by agents via `cortextos bus update-cron-fire <name> --interval <interval>`.
 */
export function updateCronFire(
  stateDir: string,
  cronName: string,
  interval?: string,
): void {
  ensureDir(stateDir);
  const state = readCronState(stateDir);
  const now = new Date().toISOString();

  const idx = state.crons.findIndex(r => r.name === cronName);
  const record: CronFireRecord = { name: cronName, last_fire: now, ...(interval ? { interval } : {}) };

  if (idx === -1) {
    state.crons.push(record);
  } else {
    state.crons[idx] = record;
  }

  state.updated_at = now;
  writeFileSync(cronStatePath(stateDir), JSON.stringify(state, null, 2) + '\n', 'utf-8');
}

/**
 * Parse an interval string like "6h", "30m", "1d", "2w" into milliseconds.
 * Returns NaN for unrecognised formats (e.g. cron expressions like "0 8 * * *").
 */
export function parseDurationMs(interval: string): number {
  const match = /^(\d+)(m|h|d|w)$/.exec(interval.trim());
  if (!match) return NaN;
  const n = parseInt(match[1], 10);
  const unit = match[2];
  const multipliers: Record<string, number> = {
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  };
  return n * multipliers[unit];
}

/**
 * Estimate the minimum expected firing interval for a 5-field cron expression.
 * Handles common patterns (every-N-minutes, every-N-hours, daily) without an
 * external library. Returns a conservative 48h fallback for anything else.
 */
export function cronExpressionMinIntervalMs(expr: string): number {
  const FALLBACK_MS = 48 * 3_600_000;
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return FALLBACK_MS;
  const [minute, hour] = parts;

  // Every N minutes: */N * * * *
  const everyMin = /^\*\/(\d+)$/.exec(minute);
  if (everyMin && hour === '*') return parseInt(everyMin[1], 10) * 60_000;

  // Every N hours: <fixed-minute> */N * * *
  const everyHour = /^\*\/(\d+)$/.exec(hour);
  if (everyHour) return parseInt(everyHour[1], 10) * 3_600_000;

  // Fixed hour — fires daily, weekly, or monthly depending on DOW/DOM restrictions
  if (/^\d+$/.test(hour)) {
    const dow = parts[4];
    const dom = parts[2];

    /*
     * AND-semantics note (src/daemon/cron-scheduler.ts nextFireFromCron):
     * ALL five fields (months && doms && dows && hours && minutes) must match
     * for a fire. When both DOM and DOW are restricted, the cron fires at
     * most as often as the RARER field — conservative estimate is monthly
     * (28d), since a 1st-of-month-Monday can fire 4–5 times per month but
     * never more than once per month.
     *
     * Lists/ranges/steps are approximated as 24h (daily-ish on active days).
     * This is conservative because a too-short estimate only causes gap-nudges
     * to fire slightly early, never late — the agent will not miss a fire.
     * (Single-value fields use true minimums: 7d for DOW, 28d for DOM.)
     */

    const dowRestricted = dow !== '*';
    const domRestricted = dom !== '*';

    if (dowRestricted && domRestricted) {
      // AND semantics: both DOM and DOW restrict the schedule.
      // ALL fields must match, so the effective minimum interval is the
      // RARER of the two constraints. Conservative floor is monthly (28d).
      // Out-of-range single values → invalid expression → FALLBACK_MS.
      const singleDow = /^\d+$/.exec(dow);
      const singleDom = /^\d+$/.exec(dom);
      if (singleDow) {
        const dowVal = parseInt(singleDow[0], 10);
        if (dowVal < 0 || dowVal > 6) return FALLBACK_MS;
      }
      if (singleDom) {
        const domVal = parseInt(singleDom[0], 10);
        if (domVal < 1 || domVal > 31) return FALLBACK_MS;
      }
      return 28 * 24 * 3_600_000;
    }

    if (dowRestricted) {
      const singleDow = /^\d+$/.exec(dow);
      if (singleDow) {
        const v = parseInt(singleDow[0], 10);
        if (v < 0 || v > 6) return FALLBACK_MS;
        return 7 * 24 * 3_600_000;
      }
      return 24 * 3_600_000;
    }

    if (domRestricted) {
      const singleDom = /^\d+$/.exec(dom);
      if (singleDom) {
        const v = parseInt(singleDom[0], 10);
        if (v < 1 || v > 31) return FALLBACK_MS;
        return 28 * 24 * 3_600_000;
      }
      return 24 * 3_600_000;
    }

    return 24 * 3_600_000;
  }

  return FALLBACK_MS;
}
