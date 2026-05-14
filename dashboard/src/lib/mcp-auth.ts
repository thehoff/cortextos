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

  // Bearer tokens are validated by NextAuth via the providers chain;
  // by this point if a bearer was used the session would already be
  // present and we trust it. For cookie-authed requests, additionally
  // enforce Origin to mitigate CSRF.
  const auth_header = req.headers.get('authorization');
  if (auth_header && auth_header.toLowerCase().startsWith('bearer ')) {
    return null;
  }

  // Cookie-authed request. The Origin header is set by browsers on
  // non-GET requests (and on some GETs). A missing Origin on a write
  // route is suspicious — reject.
  const origin = req.headers.get('origin');
  if (!origin) {
    return NextResponse.json({ error: 'origin header required for cookie-authed writes' }, { status: 403 });
  }
  if (!allowedOrigins().has(origin)) {
    return NextResponse.json({ error: `origin ${origin} not allowed` }, { status: 403 });
  }
  return null;
}
