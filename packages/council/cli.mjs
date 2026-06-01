#!/usr/bin/env node
// council — fan a file/diff out to the model peers in parallel and aggregate.
//   council review <path> [--peers codex,agy,opencode] [--instruction "..."]
//                         [--cwd <dir>] [--timeout <ms>] [--json]
//   council review --diff [--peers ...]      review `git diff` of --cwd
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { resolvePeers } from "./src/peers.mjs";
import { resolveAgents } from "./src/agents.mjs";
import { loadCortextAgents } from "./src/cortext-agents.mjs";
import { review } from "./src/review.mjs";

const argv = process.argv.slice(2);
const cmd = argv[0];
const has = (n) => argv.includes(`--${n}`);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const positional = () => { for (let i = 1; i < argv.length; i++) { if (argv[i].startsWith("--")) { i++; continue; } return argv[i]; } };

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
  --timeout <ms>        per-peer timeout (default 300000)
  --json                print raw JSON`;

if (cmd !== "review") { console.log(HELP); process.exit(cmd ? 2 : 0); }

const cwd = opt("cwd", process.cwd());
let content, label;
if (has("diff")) {
  content = execSync("git diff", { cwd, encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 });
  label = "working-tree diff";
  if (!content.trim()) { console.error("council: empty diff"); process.exit(1); }
} else {
  const path = positional();
  if (!path) { console.error("review: missing <path>\n\n" + HELP); process.exit(2); }
  content = readFileSync(path, "utf-8");
  label = path;
}

// Peer selection: explicit CLI peers (--peers), registry agent ids (--agents),
// or a registry role (--role); default = enabled reviewers from the registry.
let peers;
if (has("cortext")) peers = loadCortextAgents(opt("cortext", join(process.env.HOME || ".", ".cortextos", "orgs")));
else if (has("agents")) peers = resolveAgents({ ids: opt("agents", "").split(",").map((s) => s.trim()).filter(Boolean) });
else if (has("role")) peers = resolveAgents({ filter: { role: opt("role", "reviewer"), enabled: true } });
else if (has("peers")) peers = resolvePeers(opt("peers", "").split(",").map((s) => s.trim()).filter(Boolean));
else peers = resolveAgents({ filter: { enabled: true } }).filter((p) => (p.role || "").includes("review"));
const instruction = opt("instruction", undefined);
const timeoutMs = Number(opt("timeout", "300000"));

console.error(`council: dispatching "${label}" to ${peers.map((p) => p.id).join(", ")} …`);
const t0 = Date.now();
const { results, summary } = await review({
  content, instruction, peers, cwd, timeoutMs,
  onEvent: (e) => console.error(`  [${e.stage}] ${e.peer}`),
});

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
