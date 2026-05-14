/**
 * Fixture: MCP server that returns an image-content block on tool call.
 * Used by tests/unit/mcp/client.test.ts to pin the "MCP tool returned
 * unsupported non-text content" rejection path (Codex pass-3 PR5-028).
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'fixture-image', version: '0.0.1' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'image_only', description: 'returns image content only', inputSchema: { type: 'object' } },
    { name: 'mixed', description: 'returns mixed text + image content', inputSchema: { type: 'object' } },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === 'image_only') {
    return { content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] };
  }
  if (req.params.name === 'mixed') {
    return {
      content: [
        { type: 'text', text: 'caption' },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      ],
    };
  }
  return { content: [{ type: 'text', text: 'unknown' }], isError: true };
});

void server.connect(new StdioServerTransport());
