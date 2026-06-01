// Scorecard ledger (v0) — append one JSON line per council job so we can later
// answer "which model gives the best code back, by task type" empirically.
// Outcome (did it merge / pass tests) is filled in later; v0 captures the run.
// Lives at <repo>/.council/scorecard.jsonl (gitignored — a local dataset).
import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

function ledgerPath(repoRoot) { return join(repoRoot, ".council", "scorecard.jsonl"); }

/** Append a job record. `row` should include ts, worker, task, lane, filesChanged. */
export function recordJob(repoRoot, row) {
  mkdirSync(join(repoRoot, ".council"), { recursive: true });
  appendFileSync(ledgerPath(repoRoot), JSON.stringify(row) + "\n");
}

/** Read all rows (for `council scorecard`). */
export function readLedger(repoRoot) {
  const p = ledgerPath(repoRoot);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

/** Roll up per-worker counts (v0 — extend with outcome rates once recorded). */
export function rollup(repoRoot) {
  const byWorker = {};
  for (const r of readLedger(repoRoot)) {
    const w = (byWorker[r.worker] ??= { jobs: 0, ok: 0, filesChanged: 0 });
    w.jobs++; if (r.ok) w.ok++; w.filesChanged += r.filesChanged || 0;
  }
  return byWorker;
}
