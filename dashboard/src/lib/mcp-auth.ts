/**
 * Auth + Origin allowlist helper for PR6 dashboard MCP-management routes.
 *
 * Codex pass-1 PR6-001 (HIGH): the dashboard middleware checks for the
 * presence of a session cookie but does not verify the NextAuth JWT.
 * For read-only routes that's tolerable; for PR6 endpoints that write
 * arbitrary `command` strings into agent config.json (and which the
 * runner subsequently spawns), presence-only is too weak.
 *
 * Codex pass-1 PR6-003 (MEDIUM): cookie-authed POST/DELETE without an
 * Origin check is CSRF-shaped. SameSite=Lax on the auth cookies helps
 * but isn't enough for state-changing endpoints that can configure
 * subprocesses.
 *
 * This helper centralizes both checks. Every PR6 write handler calls
 * `requireWriteAuth(request)` as the first line.
 */
import { NextRequest, NextResponse } from 'next/server';
import { auth } from './auth';

/**
 * Origins that are allowed to make cookie-authed write requests.
 * In dev this is the localhost dashboard origins; in production the
 * deployment's public URL. Configurable via DASHBOARD_ALLOWED_ORIGINS
 * (comma-separated) for tunnel / proxy setups.
 */
function allowedOrigins(): Set<string> {
  const fromEnv = process.env.DASHBOARD_ALLOWED_ORIGINS;
  if (fromEnv && fromEnv.trim().length > 0) {
    return new Set(fromEnv.split(',').map(s => s.trim()).filter(Boolean));
  }
  return new Set([
    'http://localhost:3000',
    'http://localhost:3300',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:3300',
  ]);
}

/**
 * Verify the request is authenticated AND originates from an allowed
 * origin (for cookie auth) OR carries a valid bearer token. Returns
 * `null` if the request is authorized; returns a NextResponse to
 * propagate back to the client if not.
 *
 * Caller pattern:
 *
 *   const deny = await requireWriteAuth(req);
 *   if (deny) return deny;
 *   // ... handler body
 */
export async function requireWriteAuth(req: NextRequest): Promise<NextResponse | null> {
  const session = await auth();
  if (!session || !session.user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // Codex pass-2 PR6-014: the previous implementation short-circuited
  // the Origin check when an Authorization: Bearer header was present,
  // on the theory that bearer tokens would have been verified upstream.
  // That was wrong — `auth()` only verifies the NextAuth session cookie;
  // it does not consume or verify mobile bearer JWTs. The shortcut left
  // a path that skipped Origin validation without completing real
  // verification. PR6 supports cookie auth only — the Origin allowlist
  // applies to every write request that reaches here. If a future PR
  // adds bearer-token support, the verification step must happen BEFORE
  // any decision to bypass the Origin check.
  const origin = req.headers.get('origin');
  if (!origin) {
    return NextResponse.json({ error: 'origin header required for writes' }, { status: 403 });
  }
  if (!allowedOrigins().has(origin)) {
    return NextResponse.json({ error: `origin ${origin} not allowed` }, { status: 403 });
  }
  return null;
}
