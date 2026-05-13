/**
 * MCP fixture server for PR5 client tests: exposes a couple of text-only
 * tools (echo, env_peek). Wrapped in an IIFE so tsx (CJS mode) doesn't
 * choke on top-level await.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'fixture-echo', version: '0.0.1' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'echo', description: 'echo the input', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
    { name: 'env_peek', description: 'return one env var', inputSchema: { type: 'object', properties: { var: { type: 'string' } }, required: ['var'] } },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === 'echo') {
    const text = (req.params.arguments as { text?: string } | undefined)?.text ?? '';
    return { content: [{ type: 'text', text }] };
  }
  if (req.params.name === 'env_peek') {
    const name = (req.params.arguments as { var?: string } | undefined)?.var ?? '';
    const val = process.env[name] ?? '(unset)';
    return { content: [{ type: 'text', text: val }] };
  }
  return { content: [{ type: 'text', text: 'unknown tool' }], isError: true };
});

void server.connect(new StdioServerTransport());
