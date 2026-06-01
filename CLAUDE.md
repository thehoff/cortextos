# myCortex — the Hoff's agentic OS

A core framework to leverage multiple models seamlessly — for the council and
other projects. A fork of **cortextOS** (persistent multi-agent runtime, PTY
backends, bus, Next.js dashboard) with the council, local-LLM, branding, and
publishing layers built on top. Local-first; `lab` (Gitea) is primary; the
GitHub fork `thehoff/cortextos` is the upstream-PR path; never push to upstream.

## The five laws (project constitution — enforce these)

1. **Parallel agent workstreams.** Decompose work across isolated agents/
   worktrees by default — coding workers as well as reviews.
2. **Multi-agent council is MANDATORY — never solo.** ALL substantive work
   (design, build decisions, review) goes through the council (Codex + AGY +
   OpenCode/MiniMax now; local nyx/brain voices when online), led not tacked-on.
   Solo only for trivial mechanical edits. Use `@mycortex/council`.
3. **Build on top, stay bidirectional.** Every addition is EITHER (a)
   disconnected/modular (a pluggable module that never edits the base) OR (b) a
   clean, justifiable upstream PR. Nothing in between. Track each in
   `BACKPORT.md`. cortextOS is law — adapt to it, never break it.
4. **Local-first ownership.** Tracked in local git (`lab` primary). `upstream`
   (grandamenium/cortextos) is **pull-only** — never push to it; PRs are manual,
   Hoff-initiated.
5. **Minimal-AI / cheapest-competent-worker.** Deterministic Node first; tiny
   local edge model second; frontier peers only for real judgement. **Node.js
   for everything we build.**

Theming is **shadcn** (cortext is law): one CSS-variable token file = one brand;
rebrand the whole system by swapping the token file.

## Framework components (how other projects leverage it)

- **`packages/council/`** — multi-model dispatcher. `council review <path>`/
  `--diff`/`--cortext <orgsDir>` fans a task/diff to peers in parallel and
  aggregates. Agent registry (`agents.json`) with per-agent system prompts;
  consumes the canonical cortextOS agent registry.
- **Local-LLM runtime** — agents run on any OpenAI-compatible endpoint (local
  vLLM/llama.cpp or OpenRouter): `add-agent --runtime openai-compatible`, set
  `endpoint`/`model`/`api_key_env` + `SYSTEM_PROMPT.md`. Configure in the
  dashboard (Agent settings → Runtime). Each agent is its own
  `{endpoint, api_key_env, model}` bundle. API keys come from env vars, never
  the repo.
- **`packages/hoff-ui/`** — the BrandPack (shadcn theme + generator).
- **`tools/scribe/`** — markdown → branded HTML publisher (no daemon).

Specs: `~/Personas/thehoff/_workspace/specs/2026-06-01-mycortex-*`.

---

# Contributing to cortextOS (upstream base)

## Development Setup

```bash
git clone https://github.com/grandamenium/cortextos.git
cd cortextos
npm install
npm run build
npm test
```

## Before Submitting Changes

1. `npm run build` — TypeScript must compile cleanly
2. `npm test` — all tests must pass
3. Match existing patterns in `src/` for new features
4. Add unit tests in `tests/` for any new code

## Project Structure

- `src/` — TypeScript source (bus, cli, daemon, hooks, types, utils)
- `bus/` — Shell wrapper scripts (delegate to `dist/cli.js bus`)
- `dashboard/` — Next.js 14 web dashboard
- `templates/` — Agent templates (agent, orchestrator, analyst)
- `community/` — Community skills and agent catalog
- `tests/` — Unit, integration, and E2E tests

## Code Style

- TypeScript strict mode
- No external runtime dependencies beyond what's in `package.json`
- File operations use atomic writes (see `src/utils/atomic.ts`)
- All bus operations go through `src/bus/` modules
