/**
 * Fixture: like server-echo but writes its PID to MCP_PIDFILE on startup
 * (synchronously, before the SDK transport handshake). Used by
 * shutdown/SIGTERM integration tests to verify the child process is
 * actually reaped, not just that the parent runner returned.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { writeFileSync } from 'fs';

const pidfile = process.env.MCP_PIDFILE;
if (pidfile) {
  writeFileSync(pidfile, String(process.pid));
}

const server = new Server(
  { name: 'fixture-pid-track', version: '0.0.1' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'echo', description: 'echo the input', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === 'echo') {
    const text = (req.params.arguments as { text?: string } | undefined)?.text ?? '';
    return { content: [{ type: 'text', text }] };
  }
  return { content: [{ type: 'text', text: 'unknown' }], isError: true };
});

void server.connect(new StdioServerTransport());
