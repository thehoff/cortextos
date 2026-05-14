/**
 * PR6 MCP-server STATIC details endpoint.
 *
 * GET /api/mcp-servers/[name]
 *
 * Returns directory existence, dist/index.js presence (built status),
 * and the package.json triplet (name/version/description) if readable.
 * Codex pass-1 PR6-008: this route does NOT execute the MCP server.
 * "Declared tools" listing is deferred to a future PR with a manifest.
 */
import { NextRequest, NextResponse } from 'next/server';
import { _readStaticDetails } from '../route';

export const dynamic = 'force-dynamic';

const MCP_SERVER_NAME_RE = /^[a-z][a-z0-9-]*$/;

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ name: string }> },
): Promise<NextResponse> {
  const { name: rawName } = await ctx.params;
  const name = decodeURIComponent(rawName);
  if (!MCP_SERVER_NAME_RE.test(name) || name.length > 32) {
    return NextResponse.json({ error: 'name must match /^[a-z][a-z0-9-]*$/ (length 1..32)' }, { status: 400 });
  }
  try {
    const details = _readStaticDetails(name);
    if (!details.exists) {
      return NextResponse.json({ error: 'not found', name }, { status: 404 });
    }
    return NextResponse.json(details);
  } catch (err) {
    console.error('[api/mcp-servers/[name]] GET error:', err);
    return NextResponse.json({ error: 'failed to read details' }, { status: 500 });
  }
}
