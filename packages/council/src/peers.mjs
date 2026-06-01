// Peer registry — how each council voice is invoked headlessly. The peers are
// the only AI in the loop (Law 5); the dispatcher around them is deterministic.
// Each peer is a CLI we already validated: codex / agy / opencode(MiniMax 2.7).
// Claude is the driver/synthesiser, so it is not a peer here.
import { spawn } from "node:child_process";

/** Spawn a command, feed the prompt as an argv element, capture stdout.
 * Default 10-min floor — the council CLIs (codex/agy/opencode) are slow agentic
 * harnesses; per-agent `timeoutMs` (PEER_DEFS) overrides this. Do NOT shrink to
 * "make it fast" — slowness is not a reason to swap in cheaper models. */
function exec(cmd, args, { cwd, timeoutMs = 600000 } = {}) {
  return new Promise((resolve) => {
    let out = "", err = "", done = false;
    let child;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => { try { child && child.kill("SIGKILL"); } catch {} finish({ ok: false, error: "timeout", text: out.trim() }); }, timeoutMs);
    try {
      // stdin MUST be closed: codex/agy/opencode read stdin in addition to the
      // prompt arg ("Reading additional input from stdin...") and block on EOF
      // forever if it stays open — the REAL cause of the F5 "timeouts".
      child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return finish({ ok: false, error: e.message, text: "" });
    }
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => finish({ ok: false, error: e.message, text: out.trim() }));
    child.on("close", (code) => finish({ ok: code === 0, code, text: out.trim(), err: err.trim() }));
  });
}

/** Built-in peer definitions. `build(prompt)` -> [cmd, args]. */
export const PEER_DEFS = {
  codex: {
    id: "codex",
    model: "gpt-5.4-mini",
    timeoutMs: 600000,   // 10 min — codex exec deep reasoning is slow
    build: (prompt) => ["codex", ["exec", "--skip-git-repo-check", prompt]],
    // WRITE mode for `council job` — workspace-write confines edits to the cwd
    // (the lane), not the wider disk. The lane path is passed EXPLICITLY via
    // --cd: spawn cwd alone is not enough — the worker inherits $PWD from the
    // shell that launched the dispatcher and may trust it over getcwd().
    jobBuild: (prompt, cwd) => ["codex", ["exec", "--sandbox", "workspace-write", "--skip-git-repo-check", ...(cwd ? ["--cd", cwd] : []), "--", prompt]],
  },
  agy: {
    id: "agy",
    model: "gemini (antigravity)",
    timeoutMs: 600000,   // 10 min outer kill
    // agy's own --print-timeout defaults to 5m and would self-abort first; raise it to match.
    build: (prompt) => ["agy", ["--print-timeout", "10m", "-p", prompt]],
  },
  opencode: {
    id: "opencode",
    model: "minimax/MiniMax-M2.7",
    timeoutMs: 900000,   // 15 min — opencode `plan` agent spawns explore subagents; slowest
    build: (prompt) => ["opencode", ["run", "--agent", "plan", "-m", "minimax/MiniMax-M2.7", prompt]],
    // WRITE mode for `council job` — the `build` agent edits files (plan is read-only).
    // --dir MUST be the absolute lane path: opencode is client-server, and a
    // relative `--dir .` resolves against the attached server's root (or the
    // inherited $PWD), NOT the spawn cwd — workers ended up coding in the
    // dispatcher's own worktree instead of the lane.
    jobBuild: (prompt, cwd) => ["opencode", ["run", "--dir", cwd || ".", "--agent", "build", "-m", "minimax/MiniMax-M2.7", "--", prompt]],
  },
};

/**
 * OpenAI-compatible HTTP peer — the local-LLM primitive. One code path serves
 * local backends (vLLM / llama.cpp / LM Studio) AND OpenRouter / any
 * OpenAI-compatible endpoint: only `baseUrl` + key differ. Each agent carries
 * its OWN system prompt. The API key is read from an env var (never the repo).
 *
 * def: { id, model, baseUrl, apiKeyEnv?, apiKey?, systemPrompt?, role?, temperature? }
 */
export function makeOpenAIPeer(def) {
  return {
    id: def.id,
    model: def.model,
    role: def.role,
    kind: "openai",
    timeoutMs: def.timeoutMs,
    async run(userPrompt, opts = {}) {
      const timeoutMs = opts.timeoutMs ?? def.timeoutMs ?? 180000;
      if (!def.baseUrl) return { ok: false, error: "no baseUrl", text: "" };
      const apiKey = def.apiKeyEnv ? process.env[def.apiKeyEnv] : def.apiKey || "";
      const messages = [];
      if (def.systemPrompt) messages.push({ role: "system", content: def.systemPrompt });
      messages.push({ role: "user", content: userPrompt });

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(`${def.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
          body: JSON.stringify({ model: def.model, messages, temperature: def.temperature ?? 0.3, stream: false }),
          signal: ctrl.signal,
        });
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, text: (await res.text()).slice(0, 400) };
        const data = await res.json();
        const text = (data.choices?.[0]?.message?.content ?? "").trim();
        return { ok: text.length > 0, text, usage: data.usage, error: text ? undefined : "empty completion" };
      } catch (e) {
        return { ok: false, error: e.name === "AbortError" ? "timeout" : e.message, text: "" };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Materialise a CLI peer def into a runnable peer. */
export function makePeer(def) {
  return {
    id: def.id,
    model: def.model,
    kind: "cli",
    timeoutMs: def.timeoutMs,
    async run(prompt, opts = {}) {
      const [cmd, args] = def.build(prompt);
      return exec(cmd, args, { cwd: opts.cwd, timeoutMs: opts.timeoutMs ?? def.timeoutMs });
    },
  };
}

/** Resolve a list of peer ids (default: the three reviewers) to runnable peers. */
export function resolvePeers(ids = ["codex", "agy", "opencode"]) {
  return ids.map((id) => {
    const def = PEER_DEFS[id];
    if (!def) throw new Error(`unknown peer: ${id} (known: ${Object.keys(PEER_DEFS).join(", ")})`);
    return makePeer(def);
  });
}
