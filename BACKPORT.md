# BACKPORT ledger (Law 3)

Every addition is EITHER **(a) modular** (a pluggable module that never edits the
cortextOS base — stays a myCortex overlay) OR **(b) upstream-PR-candidate** (a
clean change to the base that grandamenium/cortextos could plausibly accept).
This ledger keeps the divergence legible and the merge path alive.

`upstream` (grandamenium/cortextos) is **pull-only** — opening a PR is a manual,
Hoff-initiated action. The PR-staging remote is the fork `thehoff/cortextos`.

| Addition | Location | Kind | Notes |
|---|---|---|---|
| Council dispatcher + local-LLM peer + agent registry | `packages/council/` | **(a) modular** | Standalone Node package; consumes cortextOS's registry, edits nothing in base. Not for upstream. |
| hoff-ui theme package | `packages/hoff-ui/` | **(a) modular** | First additional cortextOS theme package. Wraps `packages/hoff-ui/theme/` on top of the shared framework; no base edits. |
| Scribe (md→HTML publisher) | `tools/scribe/` | **(a) modular** | Standalone tool; no base edits. |
| OpenAI-compatible runtime | `src/pty/openai-compatible-pty.ts`, `src/openai-runner/`, `run-openai-agent` | **(b) upstream-PR** | Merged from `feat/openai-runtime-provider` (the Hoff's own fork branch). Generic local-LLM runtime — PR-worthy upstream. Already on the fork. |
| Dashboard `openai-compatible` runtime config + system-prompt editor | `dashboard/src/components/agents/settings-tab.tsx`, `.../api/agents/[name]/config` + `/system-prompt`, `runtime-badge`, `lib/config.ts` (`resolveAgentDir`), `lib/types.ts` | **(b) upstream-PR** | Generic: surfaces the openai-compatible runtime + per-agent system prompt in the dashboard. Clean, tested, back-portable to the base theming/agent UI. |
| Theming framework | `src/theming/`, `themes/`, `scripts/build-theme.mjs`, `dashboard/src/lib/theming.ts`, `dashboard/src/lib/pre-hydration-script.ts`, `dashboard/src/app/layout.tsx` | **(b) upstream-PR** | Staged on branch `feat/theming-framework`; shared contract/resolver/bootstrap for theme packages. |
| Theming-as-shadcn (Scribe consumes the shadcn token contract) | `packages/hoff-ui/theme/theme.css`, `tools/scribe/src/build.mjs`, `tools/scribe/assets/themes/cortex-base.css` | **(a) modular** | Scribe copies the generated Hoff theme CSS directly; no second hand-edited Hoff theme file to drift. |

**Rule of thumb:** if a change touches `src/`, `dashboard/`, or other base code,
it MUST be kind (b) — generic, tested, PR-worthy. If it's Hoff-specific, it MUST
be kind (a) — a module/overlay that leaves the base untouched.
