/**
 * PR6 MCP-server inventory + scaffold endpoints.
 *
 * GET  /api/mcp-servers  — list every scaffold directory under
 *                          <projectRoot>/mcp-servers/, with built status.
 *
 * POST /api/mcp-servers  — scaffold a new MCP server skeleton.
 *                          Body: { name: string }. Returns 201 + file list
 *                          on success, 409 if the destination already
 *                          exists, 400 on validation failure.
 *
 * Both routes enforce auth + Origin. POST holds a per-name lock so two
 * concurrent operators can't race past the existsSync guard inside
 * writeMcpScaffold (Codex pass-1 PR6-002).
 */
import { NextRequest, NextResponse } from 'next/server';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { getFrameworkRoot } from '@/lib/config';
import { writeMcpScaffold, ScaffoldDestExistsError } from '../../../../../src/mcp/scaffold';
import { withMcpLock } from '@/lib/mcp-locks';
import { requireWriteAuth } from '@/lib/mcp-auth';

export const dynamic = 'force-dynamic';

const MCP_SERVER_NAME_RE = /^[a-z][a-z0-9-]*$/;

interface McpServerListing {
  name: string;
  dir: string;
  built: boolean;
  hasPackageJson: boolean;
}

function mcpServersRoot(): string {
  return join(getFrameworkRoot(), 'mcp-servers');
}

function listMcpServers(): McpServerListing[] {
  const root = mcpServersRoot();
  if (!existsSync(root)) return [];
  const entries: McpServerListing[] = [];
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    entries.push({
      name,
      dir,
      built: existsSync(join(dir, 'dist', 'index.js')),
      hasPackageJson: existsSync(join(dir, 'package.json')),
    });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json({ servers: listMcpServers() });
  } catch (err) {
    console.error('[api/mcp-servers] GET error:', err);
    return NextResponse.json({ error: 'failed to list mcp-servers' }, { status: 500 });
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const deny = await requireWriteAuth(req);
  if (deny) return deny;

  let body: { name?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'body must be JSON' }, { status: 400 });
  }

  const name = body.name;
  if (typeof name !== 'string' || name.length === 0 || name.length > 32) {
    return NextResponse.json({ error: 'name must be a string of length 1..32' }, { status: 400 });
  }
  if (!MCP_SERVER_NAME_RE.test(name)) {
    return NextResponse.json({ error: 'name must match /^[a-z][a-z0-9-]*$/' }, { status: 400 });
  }

  const destDir = join(mcpServersRoot(), name);

  return withMcpLock(`scaffold:${destDir}`, async () => {
    try {
      const result = writeMcpScaffold({ serverName: name, destDir });
      return NextResponse.json(
        {
          created: true,
          dir: destDir,
          files: result.filesWritten,
          buildHint: `cd ${destDir} && npm install && npm run build`,
        },
        { status: 201 },
      );
    } catch (err) {
      if (err instanceof ScaffoldDestExistsError) {
        return NextResponse.json({ error: 'mcp server directory already exists', dir: destDir }, { status: 409 });
      }
      const msg = err instanceof Error ? err.message : String(err);
      // Validation-shaped errors come from the pure function. Map to 400.
      if (/^MCP server name/.test(msg)) {
        return NextResponse.json({ error: msg }, { status: 400 });
      }
      console.error('[api/mcp-servers] POST error:', err);
      return NextResponse.json({ error: 'scaffold failed', detail: msg }, { status: 500 });
    }
  });
}

/** Re-export for the [name] subroute (it reads listMcpServers + readPackageJson). */
export function _readStaticDetails(name: string): {
  name: string;
  dir: string;
  exists: boolean;
  built: boolean;
  hasPackageJson: boolean;
  packageJson: { name?: string; version?: string; description?: string } | null;
} {
  const dir = join(mcpServersRoot(), name);
  if (!existsSync(dir)) {
    return { name, dir, exists: false, built: false, hasPackageJson: false, packageJson: null };
  }
  const pkgPath = join(dir, 'package.json');
  let pkg: { name?: string; version?: string; description?: string } | null = null;
  if (existsSync(pkgPath)) {
    try {
      const raw = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      if (typeof raw === 'object' && raw !== null) {
        pkg = {
          name: typeof raw.name === 'string' ? raw.name : undefined,
          version: typeof raw.version === 'string' ? raw.version : undefined,
          description: typeof raw.description === 'string' ? raw.description : undefined,
        };
      }
    } catch {
      /* leave pkg null on parse error */
    }
  }
  return {
    name,
    dir,
    exists: true,
    built: existsSync(join(dir, 'dist', 'index.js')),
    hasPackageJson: pkg !== null,
    packageJson: pkg,
  };
}
