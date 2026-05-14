/**
 * PR6 dashboard page: MCP server inventory.
 *
 * Server component shell; the list + create-dialog live in
 * client components.
 */
import { McpServerList } from '@/components/mcp-servers/mcp-server-list';

export const dynamic = 'force-dynamic';

export default function McpServersPage(): React.ReactElement {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">MCP servers</h1>
        <p className="text-sm text-muted-foreground">
          Model Context Protocol servers managed by this cortextOS instance.
          Servers are spawned per-agent at boot; build a server here, then wire
          it into agents from their detail pages.
        </p>
      </header>
      <McpServerList />
    </div>
  );
}
