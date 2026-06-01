#!/usr/bin/env node
// council — fan a file/diff out to the model peers in parallel and aggregate.
//   council review <path> [--peers codex,agy,opencode] [--instruction "..."]
//                         [--cwd <dir>] [--timeout <ms>] [--json]
//   council review --diff [--peers ...]      review `git diff` of --cwd
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { execSync, execFileSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { resolvePeers } from "./src/peers.mjs";
import { resolveAgents } from "./src/agents.mjs";
import { loadCortextAgents } from "./src/cortext-agents.mjs";
import { review } from "./src/review.mjs";
import { runJob, workerIds } from "./src/job.mjs";
import { recordJob, rollup } from "./src/scorecard.mjs";

const argv = process.argv.slice(2);
const cmd = argv[0];
const BOOL = new Set(["diff", "json", "review"]);   // value-less flags
const has = (n) => argv.includes(`--${n}`);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] && (!argv[i + 1].startsWith("--") || !BOOL.has(argv[i + 1].slice(2))) ? argv[i + 1] : d; };
const positional = () => {
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      if (!BOOL.has(a.slice(2)) && i + 1 < argv.length && (!argv[i + 1].startsWith("--") || !BOOL.has(argv[i + 1].slice(2)))) i++; // skip this flag's value
      continue;
    }
    return a;
  }
};
// Main repo root even from a linked worktree (git-common-dir → /main/.git → /main),
// so the scorecard ledger is project-wide and shared across all lanes.
const mainRepoRoot = (cwd) => {
  try { return dirname(execSync("git rev-parse --path-format=absolute --git-common-dir", { cwd, encoding: "utf-8" }).trim()); }
  catch { return null; }
};

const HELP = `council — multi-model review dispatcher

  council review <path> [opts]     review a file
  council review --diff  [opts]     review the working-tree git diff

Options:
  --peers    comma list of CLI peers (codex,agy,opencode)
  --agents   comma list of registry agent ids (agents.json)
  --role     registry role (council|reviewer|specialist)
  --cortext  <orgsDir>  dispatch to the CANONICAL cortextOS agents
             (orgs/<org>/agents/*; default ~/.cortextos/orgs)
  --cwd      working dir for peers / diff
  --instruction "..."   override the critic prompt
  --timeout <ms>        per-peer timeout override (default: per-agent — codex/agy 10m, opencode 15m)
  --json                print raw JSON

  council job --worker <codex|opencode> (--cwd <dir> | --lane <name>) [--review] "<task>"
                         dispatch a CODING job to ONE worker in a worktree
  council scorecard      per-worker job rollup (from .council/scorecard.jsonl)`;

// ---- council job : a council member DOES the coding, in a worktree ----------
if (cmd === "job") {
  const worker = opt("worker");
  const task = positional();
  if (!worker || !task) {
    console.error(`usage: council job --worker <${workerIds().join("|")}> (--cwd <dir> | --lane <name>) [--review] "<task>"`);
    process.exit(2);
  }
  let dir = opt("cwd");
  if (!dir && has("lane")) {
    // Convenience: create the lane via the `worktree` skill (must be on PATH);
    // --print-path makes it emit just the path. Otherwise use --cwd <dir>.
    try { dir = execFileSync("worktree", ["new", opt("lane"), "--print-path"], { encoding: "utf-8" }).trim().split("\n").pop().trim(); }
    catch (e) { console.error(`council job: --lane needs the \`worktree\` skill on PATH — or pass --cwd <dir>. (${e.message})`); process.exit(1); }
  }
  if (!dir) { console.error("council job: provide --cwd <worktree-dir> or --lane <name>"); process.exit(2); }
  // Canonicalise: a relative --cwd would otherwise flow into spawn/--cd/--dir/PWD
  // and the worker could still resolve it against the dispatcher's directory.
  dir = resolve(dir);
  if (!mainRepoRoot(dir)) { console.error(`council job: --cwd ${dir} is not a git worktree — point it at a lane (e.g. \`worktree new <name>\`).`); process.exit(2); }
  const rawT = opt("timeout");
  const jobTimeout = (has("timeout") && rawT && Number.isFinite(Number(rawT))) ? Number(rawT) : undefined;

  console.error(`council job: ${worker} working in ${dir} …`);
  const res = await runJob({ worker, cwd: dir, task, timeoutMs: jobTimeout });

  const gitDiff = (a) => { try { return execSync(`git ${a}`, { cwd: dir, encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 }); } catch { return ""; } };
  try { execSync("git add -A", { cwd: dir }); } catch {}  // stage so NEW (untracked) files show in the diff + review too
  const diff = gitDiff("diff --cached HEAD") || gitDiff("diff --cached");
  const filesChanged = (gitDiff("diff --cached --name-only HEAD") || gitDiff("diff --cached --name-only")).split("\n").filter(Boolean).length;

  try {
    recordJob(mainRepoRoot(dir) || dir, { ts: Math.floor(Date.now() / 1000), worker, task: opt("label", task.slice(0, 100)), lane: dir, ok: res.ok, code: res.code ?? null, error: res.error ?? null, filesChanged });
  } catch {}

  console.log(`\n=== JOB ${res.ok ? "DONE" : "FAILED"} — ${worker} — ${filesChanged} file(s) changed ===`);
  if (res.error) console.log(`error: ${res.error}`);

  if (has("review") && diff.trim()) {
    // Independent review: the OTHER council members critique the worker's diff.
    const reviewers = resolveAgents({ filter: { role: "council", enabled: true } }).filter((p) => p.id !== worker);
    console.error(`\ncouncil job: ${reviewers.map((p) => p.id).join(" + ")} reviewing ${worker}'s diff …`);
    const { summary } = await review({ content: diff, instruction: `Review this diff produced by the '${worker}' worker for the task: ${task}. Hard critic, severity-tagged.`, peers: reviewers, cwd: dir });
    console.log(`=== REVIEW: responded ${summary.responded}/${summary.dispatched} · quorum ${summary.quorum} · tags ${JSON.stringify(summary.tagTally)} ===`);
    console.log(`(to commit in the lane, run: node ${process.argv[1]} review --diff --cwd ${dir})`);
  }
  process.exit(res.ok ? 0 : 1);
}

if (cmd === "scorecard") {
  const root = mainRepoRoot(process.cwd());
  if (!root) { console.error("scorecard: run inside a git repo"); process.exit(1); }
  console.log(JSON.stringify(rollup(root), null, 2));
  process.exit(0);
}

if (cmd !== "review") { console.log(HELP); process.exit(cmd ? 2 : 0); }

const cwd = opt("cwd", process.cwd());
let content, label;
if (has("diff")) {
  // `git diff HEAD` = all uncommitted tracked changes (staged + unstaged), stable
  // across staging — so the marker's hash matches at commit time. Falls back to
  // `git diff` on a repo with no HEAD yet.
  content = execSync("git diff HEAD 2>/dev/null || git diff", { cwd, encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 });
  label = "uncommitted diff (vs HEAD)";
  if (!content.trim()) { console.error("council: empty diff"); process.exit(1); }
} else {
  const path = positional();
  if (!path) { console.error("review: missing <path>\n\n" + HELP); process.exit(2); }
  content = readFileSync(path, "utf-8");
  label = path;
}

// Peer selection. DEFAULT = THE COUNCIL: codex + agy + opencode (enabled,
// role=council). Never substitute OpenRouter/other stand-ins for the council.
// --agents <ids> for explicit picks; --role <role> for a registry role; --peers
// for raw CLI peers; --cortext to dispatch to canonical cortextOS agents.
let peers;
if (has("cortext")) peers = loadCortextAgents(opt("cortext", join(process.env.HOME || ".", ".cortextos", "orgs")));
else if (has("agents")) peers = resolveAgents({ ids: opt("agents", "").split(",").map((s) => s.trim()).filter(Boolean) });
else if (has("role")) peers = resolveAgents({ filter: { role: opt("role", "council"), enabled: true } });
else if (has("peers")) peers = resolvePeers(opt("peers", "").split(",").map((s) => s.trim()).filter(Boolean));
else peers = resolveAgents({ filter: { role: "council", enabled: true } }); // THE council: codex+agy+opencode
const instruction = opt("instruction", undefined);
// Optional global override; default undefined → each peer uses its own timeout
// (PEER_DEFS: codex/agy 10m, opencode 15m). Don't force a short global cap.
const timeoutMs = (has("timeout") && Number.isFinite(Number(opt("timeout")))) ? Number(opt("timeout")) : undefined;

console.error(`council: dispatching "${label}" to ${peers.map((p) => p.id).join(", ")} …`);
const t0 = Date.now();
const { results, summary } = await review({
  content, instruction, peers, cwd, timeoutMs,
  onEvent: (e) => console.error(`  [${e.stage}] ${e.peer}`),
});

// Stamp a marker so the Law 2 commit-gate hook can verify the working diff was
// reviewed. Only for --diff reviews (the marker means "this diff was reviewed").
if (has("diff")) {
  try {
    const repoRoot = execSync("git rev-parse --show-toplevel", { cwd, encoding: "utf-8" }).trim();
    const head = (() => { try { return execSync("git rev-parse HEAD", { cwd, encoding: "utf-8" }).trim(); } catch { return null; } })();
    mkdirSync(join(repoRoot, ".council"), { recursive: true });
    writeFileSync(join(repoRoot, ".council", "last-review.json"), JSON.stringify({
      ts: Math.floor(Date.now() / 1000), label, head,
      // sha256 of the exact reviewed diff — the gate recomputes `git diff HEAD`
      // and requires an exact match, so unreviewed edits (or mtime forgery) can't pass.
      diffHash: createHash("sha256").update(content).digest("hex"),
      responded: summary.responded, dispatched: summary.dispatched,
      quorum: summary.quorum, fullPanel: summary.fullPanel, tags: summary.tagTally,
    }, null, 2));
  } catch {}
}

if (has("json")) {
  console.log(JSON.stringify({ label, summary, results }, null, 2));
} else {
  console.log(`\n=== COUNCIL VERDICT — ${label} ===`);
  console.log(`responded ${summary.responded}/${summary.dispatched} · quorum ${summary.quorum} · ${summary.note}`);
  console.log(`tags: blocker ${summary.tagTally.blocker} · high ${summary.tagTally.high} · medium ${summary.tagTally.medium} · low ${summary.tagTally.low}\n`);
  for (const r of results) {
    console.log(`\n----- ${r.peer} (${r.model}) ${r.ok ? "OK" : "FAILED: " + (r.error || "exit " + r.code)} -----`);
    if (r.ok) console.log(r.text);
  }
  console.log(`\n(${Math.round((Date.now() - t0) / 1000)}s)`);
}
