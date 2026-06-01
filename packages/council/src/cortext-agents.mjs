// Council consumer of the CANONICAL cortextOS agent registry.
//
// Decided 2026-06-01 by council vote (unanimous A): unify on cortextOS — its
// native agents are the single source of truth; the council is a CONSUMER, not
// a second registry. cortextOS agents live at
//   orgs/<org>/agents/<name>/{config.json, SYSTEM_PROMPT.md}
// where config.json is the RunnerConfig (endpoint, model, api_key_env|api_key,
// headers, runtime) and SYSTEM_PROMPT.md is the per-agent system prompt.
//
// This bridges that native config into council peers, mapping cortextOS field
// names (endpoint/api_key_env) onto the OpenAI peer. cortext is law; the
// council's own agents.json is now only the external-CLI-reviewer adjunct
// (codex/agy/opencode) + OpenRouter testbed voices.
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { makeOpenAIPeer } from "./peers.mjs";

/** Resolve ONE cortextOS agent dir -> a council peer (or null if not callable). */
export function resolveCortextAgent(agentDir) {
  const cfgPath = join(agentDir, "config.json");
  if (!existsSync(cfgPath)) return null;
  const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
  const id = cfg.name || basename(agentDir);
  const spPath = join(agentDir, "SYSTEM_PROMPT.md");
  const systemPrompt = existsSync(spPath) ? readFileSync(spPath, "utf-8").trim() : undefined;

  // Only openai-compatible agents are one-shot callable as council voices here.
  // (CLI runtimes — claude-code/codex/hermes — are persistent PTY agents, not
  // synchronous review peers; they stay in the council's CLI adjunct list.)
  if (cfg.runtime === "openai-compatible") {
    if (!cfg.endpoint || !cfg.model) return null;
    const peer = makeOpenAIPeer({
      id,
      model: cfg.model,
      role: cfg.role || "agent",
      baseUrl: cfg.endpoint,
      apiKeyEnv: cfg.api_key_env,
      apiKey: cfg.api_key,
      systemPrompt,
    });
    peer.source = "cortext";
    return peer;
  }
  return null;
}

/** Scan orgs/<org>/agents/* and resolve every callable agent to a council peer. */
export function loadCortextAgents(orgsDir) {
  if (!existsSync(orgsDir)) return [];
  const peers = [];
  for (const org of readdirSync(orgsDir)) {
    const agentsDir = join(orgsDir, org, "agents");
    if (!existsSync(agentsDir) || !statSync(agentsDir).isDirectory()) continue;
    for (const name of readdirSync(agentsDir)) {
      const dir = join(agentsDir, name);
      if (!statSync(dir).isDirectory()) continue;
      const peer = resolveCortextAgent(dir);
      if (peer) peers.push(peer);
    }
  }
  return peers;
}
