# {{agent_name}} — OpenAI-compatible specialist

> Audience: orchestrators or other cortextOS agents that may delegate work
> to this minion. The minion itself does not read this file — it has its
> own minimal `SYSTEM_PROMPT.md`.

## What this agent is

A single-purpose specialist agent backed by a local OpenAI-compatible LLM
endpoint (llama.cpp server, vLLM, LM Studio, Ollama, etc.). Lightweight: one
LLM call per inbox message, no Claude skills, no codex skills, no Telegram.

Configure `endpoint` and `model` in `config.json` before enabling.

## How to dispatch to this agent

    cortextos bus send-message {{agent_name}} <priority> "<question text>"

## Conversational memory

Prepend a memory header to the body so the agent's reply references prior
turns in the same thread:

    cortextos bus send-message {{agent_name}} normal "[memory: thread-42] What was that earlier number?"

`<id>` is any string the caller chooses. Same id across multiple messages
= same conversation thread. The runner persists the thread under
`<agent_dir>/memory/<id>.jsonl`.

## What this agent CANNOT do

- No multi-step Claude-style reasoning. Tool use (introduced in a
  later runtime version) is bounded by `tool_loop_max_iterations`
  and is for retrieval/utility tools, not open-ended planning.
- No Telegram, no Claude skills, no codex skills.

For multi-step tasks, decompose into single questions and dispatch each
separately, then combine the answers in your own reasoning.

## Configuring against a hosted provider

The `openai-compatible` runtime accepts any endpoint that speaks the
OpenAI `/v1/chat/completions` shape. To point an agent at a hosted
provider (OpenRouter, Together, Groq, Fireworks, etc.) without
committing a secret to `config.json`:

1. Place the API key in your org-level `secrets.env`:

       OPENROUTER_API_KEY=sk-or-...

2. In the agent's `config.json`, use `api_key_env` instead of `api_key`:

       {
         "endpoint": "https://openrouter.ai/api",
         "model": "anthropic/claude-3.5-haiku",
         "api_key_env": "OPENROUTER_API_KEY",
         "provider": "openrouter",
         "headers": {
           "HTTP-Referer": "https://your-app.example",
           "X-Title": "Your app"
         }
       }

### Field reference

- `api_key_env` — name of a `process.env` variable holding the key.
  Resolved once when the runner starts; rotating the secret requires
  `cortextos disable <agent> && cortextos enable <agent>` (or any
  other restart). Mutually exclusive with `api_key`.
- `api_key` — literal API key string. Fine for local LLMs that
  ignore Authorization; dangerous for hosted providers because the
  file is intended to be committable. Use `api_key_env` for anything
  beyond throwaway local testing.
- `headers` — extra HTTP headers merged into every LLM request. The
  runner reserves `Content-Type` and `Authorization`; setting them
  here will be rejected at config validation. CR/LF/NUL in values
  are also rejected (CRLF-injection guard).
- `provider` — informational kebab-lowercase tag. Surfaces in
  `agent_online` event metadata and the dashboard. Some values
  also trigger default headers: `provider: "openrouter"` injects
  `HTTP-Referer: https://github.com/grandamenium/cortextos` and
  `X-Title: cortextOS` so cortextOS-deployed agents accumulate
  attribution on the OpenRouter leaderboard. To attribute traffic
  to your own app, set those headers explicitly in `headers` —
  operator-set values always win. To opt out of attribution
  entirely, omit `provider`.

### Endpoint shape

The runner appends `/v1/chat/completions` to whatever you put in
`endpoint`. Common providers:

| Provider | `endpoint` value |
|---|---|
| OpenRouter | `https://openrouter.ai/api` (NOT `.../api/v1`) |
| Together | `https://api.together.xyz/v1` (NO — actually omit the `/v1`; check current docs) |
| Local llama.cpp / vLLM | `http://192.168.x.x:8080` |

If the path lands at `<your-endpoint>/v1/chat/completions` you're
correctly configured.

### When the key is wrong

On HTTP 401 or 403 from the LLM endpoint, the agent replies to the
sending inbox with a structured hint naming `api_key_env` and asking
the operator to restart the agent. After three consecutive auth
failures the runner exits non-zero so PM2 surfaces the unhealthy
state. The upstream response body is sanitized of Bearer tokens
before being embedded in any error message or event, so a debug-
style backend that echoes the inbound Authorization header cannot
leak the resolved key.
