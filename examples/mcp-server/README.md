# Example MCP server: time-oracle

A minimal MCP server that exposes two text-only tools (`now` + `greet`)
for cortextOS's openai-compatible runtime. Use it as a reference when
building your own MCP server.

## What it shows

- The MCP `Server` / `StdioServerTransport` setup pattern.
- A tool that takes no arguments (`now`).
- A tool that takes structured arguments with required/optional fields (`greet`).
- The `void server.connect(...)` pattern that works with both ESM and
  tsx-CJS transpilation.

## Try it standalone

```
npm install
npm run dev
```

The server reads JSON-RPC requests on stdin. To interact manually, use an
MCP client (cortextOS, Claude Desktop, etc.).

## Wire it into a cortextOS agent

```
# From the cortextOS project root, where mcp-servers/ lives:
cortextos init-mcp time-oracle               # creates mcp-servers/time-oracle/
# Copy this example's src/index.ts over mcp-servers/time-oracle/src/index.ts
# (or just point add-mcp at this directory's dist/index.js via --server-path)
cd mcp-servers/time-oracle && npm install && npm run build
cd -

cortextos add-mcp time-oracle --agent <agent-name>
cortextos disable <agent-name> && cortextos enable <agent-name>
```

The agent's config.json now has an `mcp_servers` entry. At boot, the
runner spawns this server, discovers its tools, and exposes them to the
LLM as `mcp__time_oracle__now` and `mcp__time_oracle__greet`.

## Tool names on the wire

cortextOS prefixes every MCP tool with `mcp__<server>__` and converts
hyphens in the server name to underscores. So `time-oracle` becomes
`time_oracle` in the qualified name. Agent configs reference tools in
this qualified form when enumerating `tools[]`:

```json
{
  "tools": [
    "mcp__time_oracle__now",
    "mcp__time_oracle__greet"
  ]
}
```

If `tools` is absent, the agent gets ALL builtin + MCP tools.

## Adding a new tool

1. Add an entry to the `tools` array in the `ListToolsRequestSchema` handler.
2. Add a branch in the `CallToolRequestSchema` handler that returns
   `{ content: [{ type: 'text', text: '...' }] }`. Non-text content
   (images, audio, resources) is rejected by cortextOS in v1.
3. Rebuild (`npm run build`) and restart the agent.

## Security notes

- Whatever process can read the agent's `config.json` can also point its
  `mcp_servers` entries at arbitrary commands. Treat agent configs as
  trusted code.
- By default the MCP server inherits ONLY a minimal env (`PATH`, `HOME`,
  `USER`, `LANG`, `NODE_ENV`). Pass secrets explicitly via the `env`
  field in `mcp_servers`:
  ```json
  {
    "mcp_servers": [{
      "name": "time-oracle",
      "command": "node",
      "args": ["./mcp-servers/time-oracle/dist/index.js"],
      "env": { "TZ_OVERRIDE": "$TIMEZONE" }
    }]
  }
  ```
  `$VAR` references resolve from the runner's environment (typically the
  org-level `secrets.env`).
