/**
 * PR6 MCP-server-from-agent unwire endpoint.
 *
 * DELETE /api/agents/[name]/mcp-servers/[server]
 *
 * Removes the named mcp_servers entry from the agent's config.json
 * via the shared unwireMcpServerFromAgent helper. Same auth + lock +
 * restart-hint contract as the wire route.
 */
import { NextRequest, NextResponse } from 'next/server';
import { unwireMcpServerFromAgent } from '../../../../../../../../src/mcp/unwire';
import { withMcpLock } from '@/lib/mcp-locks';
import { requireWriteAuth } from '@/lib/mcp-auth';
import { resolveAgentConfigPath } from '../route';

export const dynamic = 'force-dynamic';

const AGENT_NAME_RE = /^[a-z0-9_-]+$/;
const MCP_SERVER_NAME_RE = /^[a-z][a-z0-9-]*$/;

function restartHint(agent: string): string {
  return `cortextos disable ${agent} && cortextos enable ${agent}`;
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ name: string; server: string }> },
): Promise<NextResponse> {
  const deny = await requireWriteAuth(req);
  if (deny) return deny;

  const { name: rawAgent, server: rawServer } = await ctx.params;
  const agent = decodeURIComponent(rawAgent);
  const server = decodeURIComponent(rawServer);
  if (!AGENT_NAME_RE.test(agent)) {
    return NextResponse.json({ error: 'invalid agent name' }, { status: 400 });
  }
  if (!MCP_SERVER_NAME_RE.test(server)) {
    return NextResponse.json({ error: 'invalid mcp server name' }, { status: 400 });
  }

  const configPath = resolveAgentConfigPath(agent);
  if (!configPath) {
    return NextResponse.json({ error: 'agent config not found' }, { status: 404 });
  }

  return withMcpLock(`wire:${configPath}`, async () => {
    try {
      const result = unwireMcpServerFromAgent({ agentConfigPath: configPath, serverName: server });
      if (!result.removed) {
        return NextResponse.json({ error: 'mcp_servers entry not found', server }, { status: 404 });
      }
      return NextResponse.json({
        removed: true,
        removedEntry: result.removedEntry,
        restartRequired: true,
        restartCommand: restartHint(agent),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith('config.json:')) {
        return NextResponse.json({ error: msg }, { status: 400 });
      }
      console.error('[api/agents/[name]/mcp-servers/[server]] DELETE error:', err);
      return NextResponse.json({ error: 'unwire failed', detail: msg }, { status: 500 });
    }
  });
}
