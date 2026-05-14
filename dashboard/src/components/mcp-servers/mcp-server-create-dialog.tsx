'use client';

/**
 * PR6: dialog for scaffolding a new MCP server.
 *
 * Posts to /api/mcp-servers. On success, calls onCreated() so the page
 * can refresh its list. Displays the next-steps build command after a
 * successful create so the operator knows the server still needs
 * `npm install && npm run build` before wiring.
 */
import { useState, useTransition } from 'react';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const NAME_RE = /^[a-z][a-z0-9-]*$/;

interface Props {
  trigger?: React.ReactNode;
  onCreated?: (info: { name: string; dir: string; buildHint: string }) => void;
}

export function McpServerCreateDialog({ trigger, onCreated }: Props): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ dir: string; buildHint: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  const submit = (): void => {
    setError(null);
    setSuccess(null);
    if (!NAME_RE.test(name)) {
      setError('name must match /^[a-z][a-z0-9-]*$/ (kebab-lowercase, starts with a letter)');
      return;
    }
    startTransition(async () => {
      try {
        const res = await fetch('/api/mcp-servers', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name }),
        });
        const body = await res.json();
        if (!res.ok) {
          setError(body.error ?? `request failed (HTTP ${res.status})`);
          return;
        }
        setSuccess({ dir: body.dir, buildHint: body.buildHint });
        onCreated?.({ name, dir: body.dir, buildHint: body.buildHint });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  };

  const reset = (): void => {
    setName('');
    setError(null);
    setSuccess(null);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}
    >
      <DialogTrigger render={trigger ? () => <>{trigger}</> : undefined}>
        {trigger ? null : 'Create new MCP server'}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Scaffold a new MCP server</DialogTitle>
          <DialogDescription>
            Creates a TypeScript skeleton under{' '}
            <code>&lt;projectRoot&gt;/mcp-servers/&lt;name&gt;/</code>. You will
            need to <code>npm install</code> and <code>npm run build</code>
            {' '}before wiring it into an agent.
          </DialogDescription>
        </DialogHeader>

        {success ? (
          <div className="space-y-2 text-sm">
            <p className="text-green-600 dark:text-green-400">Created at:</p>
            <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded bg-muted p-2 text-xs">{success.dir}</pre>
            <p>Next, build it:</p>
            <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded bg-muted p-2 text-xs">{success.buildHint}</pre>
            <p className="text-muted-foreground">Then wire it from the agent's page.</p>
          </div>
        ) : (
          <div className="space-y-2">
            <Label htmlFor="mcp-server-name">Server name</Label>
            <Input
              id="mcp-server-name"
              value={name}
              placeholder="e.g. time-oracle"
              onChange={(e) => setName(e.target.value)}
              disabled={isPending}
            />
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        )}

        <DialogFooter>
          {success ? (
            <Button onClick={() => setOpen(false)}>Close</Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => setOpen(false)} disabled={isPending}>
                Cancel
              </Button>
              <Button onClick={submit} disabled={isPending || name.length === 0}>
                {isPending ? 'Creating…' : 'Create'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
