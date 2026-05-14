/**
 * PR6 MCP-server-to-agent wiring endpoint.
 *
 * POST /api/agents/[name]/mcp-servers
 *   Body: { name: string, command?, args?, env?, cwd?, force? }
 *   Wires a (possibly previously-scaffolded) MCP server into the
 *   agent's config.json via the shared wireMcpServerToAgent helper.
 *
 * Auth + Origin enforced by requireWriteAuth. Holds a per-agent lock
 * (Codex pass-1 PR6-002) so concurrent wire/unwire calls against the
 * same agent serialize and never clobber a shared tmp file.
 *
 * Response shape on success:
 *   {
 *     added: true | false,
 *     restartRequired: true,
 *     restartCommand: "cortextos disable <agent> && cortextos enable <agent>",
 *     ...
 *   }
 * (Codex pass-1 PR6-005 — every write response surfaces the
 * disable/enable restart command verbatim.)
 */
import { NextRequest, NextResponse } from 'next/server';
import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { getFrameworkRoot, getAllAgents, getAgentDir } from '@/lib/config';
import { wireMcpServerToAgent, type McpServerSpec } from '@/lib/mcp/fs';
import { withMcpLock } from '@/lib/mcp-locks';
import { requireWriteAuth } from '@/lib/mcp-auth';

export const dynamic = 'force-dynamic';

const AGENT_NAME_RE = /^[a-z0-9_-]+$/;

export function resolveAgentConfigPath(name: string): string | null {
  const frameworkRoot = getFrameworkRoot();
  const allAgents = getAllAgents();
  const entry = allAgents.find(a => a.name.toLowerCase() === name.toLowerCase());
  if (entry) {
    const dir = getAgentDir(entry.name, entry.org || undefined);
    const p = join(dir, 'config.json');
    if (existsSync(p)) return p;
  }
  const orgsDir = join(frameworkRoot, 'orgs');
  if (existsSync(orgsDir)) {
    for (const org of readdirSync(orgsDir)) {
      const p = join(orgsDir, org, 'agents', name, 'config.json');
      if (existsSync(p)) return p;
    }
  }
  return null;
}

function restartHint(agent: string): string {
  return `cortextos disable ${agent} && cortextos enable ${agent}`;
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ name: string }> },
): Promise<NextResponse> {
  const deny = await requireWriteAuth(req);
  if (deny) return deny;

  const { name: rawAgent } = await ctx.params;
  const agent = decodeURIComponent(rawAgent);
  if (!AGENT_NAME_RE.test(agent)) {
    return NextResponse.json({ error: 'invalid agent name' }, { status: 400 });
  }

  const configPath = resolveAgentConfigPath(agent);
  if (!configPath) {
    return NextResponse.json({ error: 'agent config not found' }, { status: 404 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'body must be JSON' }, { status: 400 });
  }

  const serverName = body.name;
  if (typeof serverName !== 'string' || serverName.length === 0 || serverName.length > 32) {
    return NextResponse.json({ error: 'name must be a string of length 1..32' }, { status: 400 });
  }
  // Name-shape check at the route layer (kebab-lowercase) so a bad name
  // returns 400 BEFORE we hit the dist/index.js existence check below
  // (which would otherwise mask the shape error as a 422 build-missing
  // error for the operator).
  if (!/^[a-z][a-z0-9-]*$/.test(serverName)) {
    return NextResponse.json({ error: 'name must match /^[a-z][a-z0-9-]*$/' }, { status: 400 });
  }

  // Default: assume the server lives at <projectRoot>/mcp-servers/<name>/dist/index.js,
  // built via init-mcp + npm run build. Operator can override command/args.
  const defaultArg = join(getFrameworkRoot(), 'mcp-servers', serverName, 'dist', 'index.js');

  const serverEntry: McpServerSpec = {
    name: serverName,
    command: typeof body.command === 'string' && body.command.length > 0
      ? body.command
      : 'node',
    args: Array.isArray(body.args)
      ? body.args.filter((a): a is string => typeof a === 'string')
      : [defaultArg],
    ...(typeof body.cwd === 'string' && body.cwd.length > 0 ? { cwd: body.cwd } : {}),
    ...(typeof body.tool_timeout_sec === 'number' ? { tool_timeout_sec: body.tool_timeout_sec } : {}),
    ...(body.env && typeof body.env === 'object' && !Array.isArray(body.env)
      ? { env: body.env as Record<string, string> }
      : {}),
    ...(body.env_inherit !== undefined ? { env_inherit: Boolean(body.env_inherit) } : {}),
  };

  // Codex pass-2 PR6-018 + pass-3 PR6-021: hard-check that the
  // canonical scaffold's dist/index.js exists IF the effective args
  // reference it. The earlier check gated only on `command === 'node'`
  // but the args default still pointed at the scaffold path even when
  // command was something like 'tsx', letting curl/script callers wire
  // a config that ENOENTs the agent at boot. Inspecting the effective
  // serverEntry.args closes that bypass — the check fires for any
  // command if the args were not explicitly overridden.
  const argsExplicitlyOverridden = Array.isArray(body.args);
  if (!argsExplicitlyOverridden && serverEntry.args?.includes(defaultArg) && !existsSync(defaultArg)) {
    return NextResponse.json({
      error: `mcp server "${serverName}" has not been built — ${defaultArg} does not exist`,
      hint: `cd ${join(getFrameworkRoot(), 'mcp-servers', serverName)} && npm install && npm run build`,
    }, { status: 422 });
  }

  const force = body.force === true;

  return withMcpLock(`wire:${configPath}`, async () => {
    try {
      const result = wireMcpServerToAgent({
        agentConfigPath: configPath,
        serverEntry,
        force,
      });
      if (!result.added) {
        return NextResponse.json(
          {
            added: false,
            error: 'mcp_servers entry with that name already exists; pass force:true to replace',
            existingEntry: result.existingEntry,
          },
          { status: 409 },
        );
      }
      return NextResponse.json(
        {
          added: true,
          replacedExisting: result.existingEntry ? true : false,
          restartRequired: true,
          restartCommand: restartHint(agent),
        },
        { status: 201 },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Vendored validator throws messages starting with "mcp_servers[]"
      // or "MCP server name". Both map to 400 — bad client input.
      if (msg.startsWith('mcp_servers[]') || msg.startsWith('MCP server name') || msg.startsWith('config.json:')) {
        return NextResponse.json({ error: msg }, { status: 400 });
      }
      if (msg.includes('not valid JSON') || msg.includes('not a JSON object')) {
        return NextResponse.json({ error: msg }, { status: 422 });
      }
      console.error('[api/agents/[name]/mcp-servers] POST error:', err);
      return NextResponse.json({ error: 'wire failed', detail: msg }, { status: 500 });
    }
  });
}
