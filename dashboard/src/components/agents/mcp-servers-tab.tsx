'use client';

/**
 * PR6: per-agent MCP servers tab in the agent detail page.
 *
 * Reads /api/agents/[name]/config to see current mcp_servers entries.
 * Reads /api/mcp-servers to see available scaffolds. Lets the operator
 * wire (with build-status warning per Codex pass-1 PR6-004) and unwire
 * (with confirmation dialog per the v0.2 plan) — both surfacing the
 * restart command from the API response (Codex pass-1 PR6-005).
 */
import { useCallback, useEffect, useState, useTransition } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

interface McpServerInventory {
  name: string;
  dir: string;
  built: boolean;
  hasPackageJson: boolean;
}

interface McpServerSpec {
  name: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  env_inherit?: boolean;
  tool_timeout_sec?: number;
}

interface Props {
  agentName: string;
}

function classifyEntry(
  entry: McpServerSpec,
  inventory: McpServerInventory[],
): 'managed' | 'manual' {
  const known = inventory.find(s => s.name === entry.name);
  if (!known) return 'manual';
  // If the command points at our managed scaffold's dist/index.js, it's
  // dashboard-managed. Anything else is external/manual.
  const expected = `${known.dir}/dist/index.js`;
  if (entry.command === 'node' && (entry.args?.[0] ?? '') === expected) return 'managed';
  return 'manual';
}

export function McpServersTab({ agentName }: Props): React.ReactElement {
  const [inventory, setInventory] = useState<McpServerInventory[]>([]);
  const [wired, setWired] = useState<McpServerSpec[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restartHint, setRestartHint] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const load = useCallback(async () => {
    try {
      const [invRes, cfgRes] = await Promise.all([
        fetch('/api/mcp-servers'),
        fetch(`/api/agents/${encodeURIComponent(agentName)}/config`),
      ]);
      const invBody = await invRes.json();
      const cfgBody = await cfgRes.json();
      if (!invRes.ok) throw new Error(invBody.error ?? `HTTP ${invRes.status}`);
      if (!cfgRes.ok) throw new Error(cfgBody.error ?? `HTTP ${cfgRes.status}`);
      setInventory((invBody.servers as McpServerInventory[]) ?? []);
      setWired((cfgBody.config?.mcp_servers as McpServerSpec[]) ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [agentName]);

  useEffect(() => { void load(); }, [load]);

  const wire = (serverName: string): void => {
    setError(null);
    setRestartHint(null);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/agents/${encodeURIComponent(agentName)}/mcp-servers`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: serverName }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        setRestartHint(body.restartCommand ?? null);
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  };

  const unwire = (serverName: string): void => {
    setError(null);
    setRestartHint(null);
    startTransition(async () => {
      try {
        const res = await fetch(
          `/api/agents/${encodeURIComponent(agentName)}/mcp-servers/${encodeURIComponent(serverName)}`,
          { method: 'DELETE' },
        );
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        setRestartHint(body.restartCommand ?? null);
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  };

  // Candidate scaffolds the operator could wire (i.e. in inventory but
  // not already wired). Filtering happens client-side so the dropdown
  // can show inline build status.
  const wiredNames = new Set((wired ?? []).map(w => w.name));
  const candidates = inventory.filter(s => !wiredNames.has(s.name));

  return (
    <div className="space-y-4">
      <header>
        <h2 className="text-lg font-medium">MCP servers</h2>
        <p className="text-sm text-muted-foreground">
          Model Context Protocol servers this agent spawns at boot. Changes
          require <code>cortextos disable {agentName} &amp;&amp; cortextos enable {agentName}</code>
          {' '}to take effect.
        </p>
      </header>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {restartHint && (
        <Card className="border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <p className="font-medium">Restart required</p>
          <pre className="mt-1 rounded bg-background/60 p-2 text-xs">{restartHint}</pre>
        </Card>
      )}

      {!wired ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : wired.length === 0 ? (
        <Card className="p-4 text-sm text-muted-foreground">
          This agent has no MCP servers wired. Add one from the inventory below.
        </Card>
      ) : (
        <div className="grid gap-2">
          {wired.map(entry => {
            const kind = classifyEntry(entry, inventory);
            return (
              <Card key={entry.name} className="flex items-center justify-between gap-4 p-3">
                <div>
                  <p className="font-mono text-sm font-medium">{entry.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {entry.command} {(entry.args ?? []).join(' ')}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {kind === 'manual' ? (
                    <Badge variant="outline">manual / external</Badge>
                  ) : (
                    <Badge>managed</Badge>
                  )}
                  <UnwireDialog
                    agentName={agentName}
                    serverName={entry.name}
                    disabled={isPending}
                    onConfirm={() => unwire(entry.name)}
                  />
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <div className="space-y-2 border-t pt-4">
        <h3 className="text-sm font-medium">Wire a new server</h3>
        {candidates.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No additional scaffolds available. Create one from the{' '}
            <a href="/mcp-servers" className="underline">MCP servers page</a>.
          </p>
        ) : (
          <WireForm candidates={candidates} disabled={isPending} onSubmit={wire} />
        )}
      </div>
    </div>
  );
}

function WireForm({
  candidates,
  disabled,
  onSubmit,
}: {
  candidates: McpServerInventory[];
  disabled: boolean;
  onSubmit: (name: string) => void;
}): React.ReactElement {
  const [selected, setSelected] = useState<string>(candidates[0]?.name ?? '');
  const chosen = candidates.find(c => c.name === selected);
  return (
    <div className="space-y-2">
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Select value={selected} onValueChange={(v) => setSelected(v ?? '')} disabled={disabled}>
            <SelectTrigger><SelectValue placeholder="Pick a server" /></SelectTrigger>
            <SelectContent>
              {candidates.map(c => (
                <SelectItem key={c.name} value={c.name}>
                  {c.name} {c.built ? '' : '(not built)'}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button onClick={() => onSubmit(selected)} disabled={disabled || !selected}>
          Wire
        </Button>
      </div>
      {chosen && !chosen.built && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          ⚠ This server hasn't been built. Wiring it now will create a
          config that fails at agent boot until you run:{' '}
          <code>cd {chosen.dir} &amp;&amp; npm install &amp;&amp; npm run build</code>
        </p>
      )}
    </div>
  );
}

function UnwireDialog({
  agentName,
  serverName,
  disabled,
  onConfirm,
}: {
  agentName: string;
  serverName: string;
  disabled: boolean;
  onConfirm: () => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger disabled={disabled}>Unwire</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Unwire {serverName}?</DialogTitle>
          <DialogDescription>
            Removes the <code>{serverName}</code> entry from{' '}
            <code>{agentName}</code>'s config.json. The scaffold under
            mcp-servers/ is NOT deleted; you can rewire it later.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button
            variant="destructive"
            onClick={() => { setOpen(false); onConfirm(); }}
          >
            Unwire
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
