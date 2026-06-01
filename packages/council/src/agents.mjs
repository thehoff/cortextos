// Agent registry: load + validate agents.json, resolve each to a runnable peer.
// kind=cli -> CLI peer (codex/agy/opencode); kind=openai -> OpenAI-compatible
// HTTP peer (local vLLM/llama.cpp or OpenRouter). Per-agent system prompts live
// here. This is the data model the dashboard agent-config UI reads and writes.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PEER_DEFS, makePeer, makeOpenAIPeer } from "./peers.mjs";

const DEFAULT_REGISTRY = join(dirname(fileURLToPath(import.meta.url)), "..", "agents.json");

/** Validate one agent entry. Returns an array of problem strings (empty = ok). */
export function validateAgent(a, seen = new Set()) {
  const errs = [];
  if (!a.id) errs.push("missing id");
  else if (seen.has(a.id)) errs.push(`duplicate id: ${a.id}`);
  if (!["cli", "openai"].includes(a.kind)) errs.push(`${a.id}: kind must be cli|openai`);
  if (a.kind === "cli" && !PEER_DEFS[a.cli || a.id]) errs.push(`${a.id}: unknown cli "${a.cli || a.id}"`);
  if (a.kind === "openai") {
    if (!a.baseUrl) errs.push(`${a.id}: openai agent needs baseUrl`);
    if (!a.model) errs.push(`${a.id}: openai agent needs model`);
  }
  return errs;
}

/** Load + validate the registry. Throws on invalid config. */
export function loadAgents(path = DEFAULT_REGISTRY) {
  const raw = JSON.parse(readFileSync(path, "utf-8"));
  const agents = raw.agents || [];
  const seen = new Set();
  const problems = [];
  for (const a of agents) {
    problems.push(...validateAgent(a, seen));
    if (a.id) seen.add(a.id);
  }
  if (problems.length) throw new Error("invalid agents.json:\n  " + problems.join("\n  "));
  return agents;
}

/** Filter helper: getAgents({ role, kind, enabled }). */
export function getAgents(filter = {}, path = DEFAULT_REGISTRY) {
  return loadAgents(path).filter((a) =>
    (filter.role == null || a.role === filter.role || (a.role || "").includes(filter.role)) &&
    (filter.kind == null || a.kind === filter.kind) &&
    (filter.enabled == null || (a.enabled !== false) === filter.enabled)
  );
}

/** Resolve an agent entry to a runnable peer (carries its system prompt). */
export function resolveAgent(a) {
  if (a.kind === "cli") {
    const peer = makePeer(PEER_DEFS[a.cli || a.id]);
    peer.role = a.role;
    peer.systemPrompt = a.systemPrompt; // CLI peers prepend it into the prompt (no system slot)
    return peer;
  }
  return makeOpenAIPeer(a);
}

/** Resolve a set of agents (by id, or a filter) to runnable peers. */
export function resolveAgents({ ids, filter, path = DEFAULT_REGISTRY } = {}) {
  const all = loadAgents(path);
  const chosen = ids ? all.filter((a) => ids.includes(a.id)) : getAgents(filter || {}, path);
  return chosen.map(resolveAgent);
}
