/**
 * GET /api/connectors/kinds
 *
 * Exposes the connector allowlist + per-kind env-var requirements so the
 * dashboard's create-agent form (#17) and the future settings tab (#2b)
 * can render dynamically without hardcoding the catalog. Source of truth
 * is `src/connectors/index.ts` — values here MUST stay in sync.
 *
 * The dashboard can't cleanly import across the package boundary today,
 * so the catalog is duplicated here (per the same pattern used in
 * `dashboard/src/lib/branding.ts`). A future PR can replace this with a
 * server-side import if the build tooling supports it.
 *
 * Response shape (versioned via the `version` field so callers can branch
 * on schema bumps if we ever need to):
 *
 * {
 *   version: 1,
 *   kinds: [
 *     { value: 'telegram', label: 'Telegram', envKeys: ['BOT_TOKEN', 'CHAT_ID', 'ALLOWED_USER'] },
 *     { value: 'none',     label: 'No channel', envKeys: [] }
 *   ]
 * }
 */
export const dynamic = 'force-static';

interface ConnectorKindDescriptor {
  value: string;
  label: string;
  description: string;
  envKeys: readonly string[];
}

const KINDS: readonly ConnectorKindDescriptor[] = [
  {
    value: 'telegram',
    label: 'Telegram',
    description:
      'Operator messages via Telegram bot. Requires a BotFather token + chat ID. Default.',
    envKeys: ['BOT_TOKEN', 'CHAT_ID', 'ALLOWED_USER'],
  },
  {
    value: 'none',
    label: 'No channel',
    description:
      'Backend / offline / batch agent. No credentials; reply via dashboard or `bus send`.',
    envKeys: [],
  },
];

export function GET() {
  return Response.json({ version: 1, kinds: KINDS });
}
