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

- No multi-step reasoning beyond a single LLM call per message.
- No Telegram, no Claude skills, no codex skills.
- No tool use (deferred to a future v2 of the runtime).

For multi-step tasks, decompose into single questions and dispatch each
separately, then combine the answers in your own reasoning.
