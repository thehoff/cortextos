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

## MCP server tools

The openai-compatible runtime can spawn MCP (Model Context Protocol)
servers per-agent and expose their tools to the LLM alongside the
builtins. Each agent owns its own subprocess(es); MCP servers do NOT
inherit secrets from the runner by default.

### Configure

Add `mcp_servers` to `config.json`:

```json
{
  "mcp_servers": [
    {
      "name": "time-oracle",
      "command": "node",
      "args": ["./mcp-servers/time-oracle/dist/index.js"],
      "tool_timeout_sec": 30
    }
  ],
  "mcp_boot_timeout_sec": 30,
  "mcp_tool_timeout_sec": 30,
  "tools": ["mcp__time_oracle__now", "get_current_time"]
}
```

The CLI manages this for you:

```
cortextos init-mcp time-oracle              # scaffolds mcp-servers/time-oracle/
cortextos add-mcp time-oracle --agent <agent-name>
```

### Field reference

- `mcp_servers[].name` — kebab-lowercase tag. Tools from this server
  appear to the LLM as `mcp__<server_with_underscores>__<tool>`
  (hyphens in the server name become underscores in the qualified
  tool name, e.g. `time-oracle` → `mcp__time_oracle__*`).
- `mcp_servers[].command`, `args`, `cwd` — subprocess invocation.
- `mcp_servers[].env` — extra env vars merged into the subprocess.
  Values matching `$VAR_NAME` resolve from the runner's environment
  at boot; the resolved value is tracked as a secret and redacted
  from error messages.
- `mcp_servers[].env_inherit` — when `true`, the subprocess inherits
  the runner's full env. **Default is `false`** so secrets like
  `OPENROUTER_API_KEY` don't reach community MCP servers by accident.
  A minimal allowlist (`PATH`, `HOME`, `USER`, `LANG`, `NODE_ENV`) is
  always inherited so basic subprocess execution works.
- `mcp_servers[].tool_timeout_sec` — per-server tool-call timeout.
- `mcp_boot_timeout_sec` — total parallel-boot budget (default 30).
  If any server doesn't complete `initialize` and `tools/list` within
  this window, the agent fails to start with a FATAL error naming the
  slow server, and any already-spawned children are torn down.
- `mcp_tool_timeout_sec` — default per-tool timeout for MCP tools
  (default 30). Vector DBs and SQL gateways are slow; the 10s
  builtin default would silently truncate too many calls.

### Tool dispatch

When `tools` is absent, the agent gets ALL builtins + ALL MCP tools.
When `tools` is set, list each one explicitly:

```json
"tools": ["get_current_time", "mcp__time_oracle__now"]
```

Tool-name typos are caught at boot via phased validation:
- Builtin name typo → fail at config load (PR3 semantics preserved).
- `mcp__<server>__*` references an undeclared server → fail at config load.
- `mcp__<server>__<typo>` where the server is real but the tool name
  doesn't exist → fail at boot, after the MCP servers come up.

### Result-shape contract

MCP tools must return text content blocks. Image, audio, or resource
blocks cause the tool call to fail with a stable sanitized message;
PR5 is text-tools only.

### Wire-protocol example

See `examples/mcp-server/` in the cortextOS repo for a minimal MCP
server (with `now` and `greet` tools) you can build on.

### When the key is wrong

On HTTP 401 or 403 from the LLM endpoint, the agent replies to the
sending inbox with a structured hint naming `api_key_env` and asking
the operator to restart the agent. After three consecutive auth
failures the runner exits non-zero so PM2 surfaces the unhealthy
state. The upstream response body is sanitized of Bearer tokens
before being embedded in any error message or event, so a debug-
style backend that echoes the inbound Authorization header cannot
leak the resolved key.
