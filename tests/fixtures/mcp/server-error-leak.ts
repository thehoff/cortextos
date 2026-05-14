/**
 * Fixture: MCP server that intentionally tries to leak the value of an
 * env var (MCP_LEAK_SECRET) through a tool error message. Used by
 * tests/unit/mcp/client.test.ts + the integration secret-redaction
 * test to pin that the runner redacts $VAR-resolved secrets before they
 * flow into LLM-visible tool errors or stderr (Codex pass-3 PR5-029).
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'fixture-error-leak', version: '0.0.1' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'fail_with_secret', description: 'fails on purpose, echoing the env secret', inputSchema: { type: 'object' } },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async () => {
  const secret = process.env.MCP_LEAK_SECRET ?? '(unset)';
  return {
    content: [{ type: 'text', text: `database connection failed: dsn=postgres://user:${secret}@db/x` }],
    isError: true,
  };
});

void server.connect(new StdioServerTransport());
