'use client';

/**
 * PR6: client-side list of MCP servers with refresh-on-create.
 */
import { useEffect, useState, useCallback } from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { McpServerCreateDialog } from './mcp-server-create-dialog';

interface ServerEntry {
  name: string;
  dir: string;
  built: boolean;
  hasPackageJson: boolean;
}

export function McpServerList(): React.ReactElement {
  const [servers, setServers] = useState<ServerEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/mcp-servers');
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setServers(body.servers as ServerEntry[]);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium">MCP servers</h2>
        <McpServerCreateDialog onCreated={() => void load()} />
      </div>

      {error && (
        <p className="text-sm text-destructive">Failed to load: {error}</p>
      )}

      {!servers ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : servers.length === 0 ? (
        <Card className="p-4 text-sm text-muted-foreground">
          No MCP servers scaffolded yet. Click "Create new MCP server" to start one,
          or check the <code>mcp-servers/</code> directory in your project root.
        </Card>
      ) : (
        <div className="grid gap-3">
          {servers.map((s) => (
            <Card key={s.name} className="flex items-center justify-between gap-4 p-4">
              <div>
                <p className="font-mono text-sm font-medium">{s.name}</p>
                <p className="text-xs text-muted-foreground">{s.dir}</p>
              </div>
              <div className="flex items-center gap-2">
                {s.built ? (
                  <Badge variant="default">built</Badge>
                ) : (
                  <Badge variant="outline">not built</Badge>
                )}
                {!s.hasPackageJson && <Badge variant="destructive">no package.json</Badge>}
              </div>
            </Card>
          ))}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        To wire an MCP server into an agent, visit that agent's page and use the
        "MCP servers" section there. The runtime spawns one subprocess per agent
        per wired server.
      </p>
    </div>
  );
}
