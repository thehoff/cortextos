# @mycortex/council — the multi-model dispatcher

The core "leverage multiple models seamlessly" engine. A **deterministic Node
orchestrator** (Law 5 — the only AI is the peers themselves) that fans a task or
diff out to the council voices **in parallel** and aggregates their verdicts.
This is the manual tri-model panel — codified, repeatable, one call.

Standalone now (shells out to the peer CLIs; no cortextOS daemon needed).
Modular (Law 3a) — designed to wrap as a cortextOS bus worker later.

## Peers (the council voices)

| id | model | invocation |
|---|---|---|
| `codex` | gpt-5.4-mini | `codex exec --skip-git-repo-check` |
| `agy` | Gemini (Antigravity) | `agy -p` |
| `opencode` | MiniMax M2.7 | `opencode run --agent plan -m minimax/MiniMax-M2.7` |

Claude is the driver/synthesiser, not a peer. (Law 2: review = the *other* voices.)

## Use

```bash
council review <path>            # review a file
council review --diff            # review the working-tree git diff
council review <path> --json     # machine-readable
council review <path> --peers codex,opencode   # subset
```

Output: each peer's verdict + an aggregate (responded/quorum, a blocker/high/
medium/low tag tally, and a flag if the panel was partial).

## Design

- **Parallel fan-out** (`Promise.all`) — wall-clock = slowest peer, not the sum.
- **Graceful degradation** — a peer that errors or times out is recorded in
  `failedPeers`; a sub-quorum run is flagged (`fullPanel:false`, partial note),
  never silently treated as a clean pass.
- **Stage events** — `review({ onEvent })` emits `{peer, stage, ts}`
  (`dispatch`/`done`/`error`). This is the seam the workflow visualiser taps to
  show voices moving through stages.
- **Aggregation is pure** — deterministic, unit-tested with mock peers (no real
  model calls in tests).

## Local LLMs + the agent registry

`agents.json` is the declarative registry — **each agent carries its own system
prompt**, model, role, and endpoint. Two kinds:

- **`cli`** — drives an agentic CLI (codex / agy / opencode).
- **`openai`** — calls an **OpenAI-compatible** `/chat/completions` endpoint.
  One code path serves **local backends** (vLLM / llama.cpp / LM Studio on
  nyx/brain) AND OpenRouter — only `baseUrl` + the API key differ. Keys are read
  from an env var (`apiKeyEnv`), never the repo.

The Hoff's model portfolio is pre-registered (council voices Qwen3.6-27B,
Gemma-4, Granite-4, Command-R7B, Llama-3.1-8B; specialists Qwen2.5-Coder-14B,
Ministral-3, Nemotron3) as `enabled:false` until their endpoints are online —
flip `enabled` + set the env key and they join the council with zero code change.

```bash
council review <path> --agents council-qwen,codex   # specific agents
council review <path> --role council                 # all enabled council voices
council review <path>                                # default: enabled reviewers
```

Per-agent system prompts apply to both kinds: `openai` peers send it in the
system slot; `cli` peers prepend it into the prompt. Validated against a mock
OpenAI-compatible stub (no creds) — 10/10 tests green.

## Canonical registry — cortextOS is the source of truth

Council vote (2026-06-01, unanimous): **unify on cortextOS**. Its native agents
(`orgs/<org>/agents/<name>/{config.json, SYSTEM_PROMPT.md}`) are the single
source of truth; the council is a **consumer**, not a second registry.
`src/cortext-agents.mjs` bridges a native agent into a council peer (maps
`endpoint`/`model`/`api_key_env` + the `SYSTEM_PROMPT.md` onto the OpenAI peer):

```bash
council review <path> --cortext ~/.cortextos/orgs   # dispatch to canonical agents
```

The council's own `agents.json` is now only the **external-CLI adjunct**
(codex/agy/opencode, which aren't cortextOS agents) + OpenRouter testbed voices.

## Next

- Wrap as a cortextOS bus worker (the automated tier) + a pre-merge git hook
  (Law 2 advisory gate).
- Perspective-diverse verify (distinct lens per peer) and loop-until-dry rounds.
