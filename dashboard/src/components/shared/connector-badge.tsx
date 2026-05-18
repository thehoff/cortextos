import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import type { ConnectorKind } from '@/lib/types';

export interface ConnectorBadgeProps {
  connector: ConnectorKind;
  className?: string;
}

/**
 * Pretty label per known connector kind. Unknown kinds fall through to the
 * raw value (capitalized first letter) so future connectors (Matrix /
 * RocketChat / Discord / Mattermost) render reasonably without a code change.
 */
function labelFor(kind: ConnectorKind): string {
  switch (kind) {
    case 'telegram': return 'Telegram';
    case 'none':     return 'No channel';
    default:         return kind.charAt(0).toUpperCase() + kind.slice(1);
  }
}

/**
 * Per-kind chrome. Unknown kinds fall through to a neutral slate scheme so
 * the badge always renders sensibly.
 */
function classesFor(kind: ConnectorKind): string {
  switch (kind) {
    case 'telegram': return 'bg-sky-500/10 text-sky-600 border-sky-500/30';
    case 'none':     return 'bg-muted text-muted-foreground border-border';
    default:         return 'bg-slate-500/10 text-slate-600 border-slate-500/30';
  }
}

export function ConnectorBadge({ connector, className }: ConnectorBadgeProps) {
  return (
    <Badge
      variant="outline"
      className={cn('font-normal', classesFor(connector), className)}
    >
      {labelFor(connector)}
    </Badge>
  );
}
