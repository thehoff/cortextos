/**
 * Example MCP server for cortextOS.
 *
 * Exposes two text-only tools so an openai-compatible agent can call
 * them via the runner's MCP integration (PR5):
 *
 *   - `now`: returns the current UTC time as ISO 8601.
 *   - `greet`: takes a name + optional language; returns "<hello>, <name>!".
 *
 * Wire it into an agent from the cortextOS project root:
 *
 *   cortextos init-mcp time-oracle   # one-time scaffold (or copy this example)
 *   cd mcp-servers/time-oracle && npm install && npm run build
 *   cortextos add-mcp time-oracle --agent rag-1
 *   cortextos disable rag-1 && cortextos enable rag-1
 *
 * Then dispatch:
 *
 *   cortextos bus send-message rag-1 normal "What time is it in UTC right now?"
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const GREETINGS: Record<string, string> = {
  en: 'hello',
  es: 'hola',
  fr: 'bonjour',
  de: 'hallo',
  ja: 'konnichiwa',
};

const server = new Server(
  { name: 'time-oracle', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'now',
      description: 'Return the current UTC time as ISO 8601.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'greet',
      description: 'Return a greeting in the requested language.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'who to greet' },
          language: { type: 'string', description: 'ISO 639-1 language code; default "en"' },
        },
        required: ['name'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === 'now') {
    return { content: [{ type: 'text', text: new Date().toISOString() }] };
  }
  if (req.params.name === 'greet') {
    const args = (req.params.arguments ?? {}) as { name?: unknown; language?: unknown };
    const name = typeof args.name === 'string' ? args.name : 'friend';
    const language = typeof args.language === 'string' ? args.language : 'en';
    const greeting = GREETINGS[language] ?? GREETINGS.en;
    return { content: [{ type: 'text', text: `${greeting}, ${name}!` }] };
  }
  return {
    content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }],
    isError: true,
  };
});

void server.connect(new StdioServerTransport());
