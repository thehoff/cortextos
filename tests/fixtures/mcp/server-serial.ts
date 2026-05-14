/**
 * Fixture: MCP server with two tools (`slow` and `quick`) that both
 * append a timestamped line to the file path in MCP_SERIAL_LOG. `slow`
 * sleeps 250ms before returning. Used by
 * tests/integration/runner-mcp-serial-dispatch.test.ts to pin that
 * multiple tool_calls in one assistant message are dispatched serially
 * (Codex PR5-012).
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { appendFileSync } from 'fs';

function logCall(tag: string): void {
  const path = process.env.MCP_SERIAL_LOG;
  if (!path) return;
  appendFileSync(path, `${Date.now()} ${tag}\n`);
}

const server = new Server(
  { name: 'fixture-serial', version: '0.0.1' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'slow', description: 'sleeps 250ms then returns "slow-done"', inputSchema: { type: 'object' } },
    { name: 'quick', description: 'returns immediately with "quick-done"', inputSchema: { type: 'object' } },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === 'slow') {
    logCall('slow-start');
    await new Promise(r => setTimeout(r, 250));
    logCall('slow-end');
    return { content: [{ type: 'text', text: 'slow-done' }] };
  }
  if (req.params.name === 'quick') {
    logCall('quick-start');
    logCall('quick-end');
    return { content: [{ type: 'text', text: 'quick-done' }] };
  }
  return { content: [{ type: 'text', text: 'unknown' }], isError: true };
});

void server.connect(new StdioServerTransport());
