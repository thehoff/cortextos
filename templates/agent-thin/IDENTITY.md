# {{agent_name}}

**Name:** {{agent_name}}
**Role:** Specialist agent
**Backed by:** Local OpenAI-compatible LLM endpoint
**Org:** {{org}}

This is a thin specialist agent. It runs a single-purpose LLM call per inbox
message via cortextOS's `openai-compatible` runtime. Configure the endpoint
and model in `config.json` before enabling.
