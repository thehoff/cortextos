/**
 * Fixture: MCP server that advertises a tool with an invalid OpenAI
 * function name (starts with a digit). Used to test PR5-005 tool-name
 * validation.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'fixture-badname', version: '0.0.1' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: '9bad-start', description: 'invalid', inputSchema: { type: 'object' } }],
}));

void server.connect(new StdioServerTransport());
