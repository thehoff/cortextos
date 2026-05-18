import { NextRequest } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { getFrameworkRoot, getCTXRoot, getAllAgents } from '@/lib/config';
import { IPCClient } from '@/lib/ipc-client';
import { getHeartbeat, getHealthStatus } from '@/lib/data/heartbeats';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_NAME = /^[a-z0-9_-]+$/;
const VALID_TEMPLATES = ['agent', 'agent-codex', 'orchestrator', 'analyst'];
// Mirrors `src/connectors/index.ts:CONNECTOR_ALLOWLIST`. Hardcoded here
// while issue #18 (the `/api/connectors/kinds` registry endpoint) is in
// flight — once that lands the dashboard fetches the list at runtime
// instead of duplicating it.
const VALID_CONNECTORS = ['telegram', 'none'] as const;
type ConnectorKind = (typeof VALID_CONNECTORS)[number];


// ---------------------------------------------------------------------------
// GET /api/agents - List all agents
// ---------------------------------------------------------------------------

export async function GET() {
  try {
    const agents = getAllAgents();
    const enriched = await Promise.all(
      agents.map(async (agent) => {
        const hb = await getHeartbeat(agent.name);
        const health = hb ? getHealthStatus(hb) : 'down';
        return {
          ...agent,
          health,
          lastHeartbeat: hb?.last_heartbeat ?? undefined,
          currentTask: hb?.current_task ?? undefined,
          status: hb?.status ?? undefined,
        };
      })
    );
    return Response.json(enriched);
  } catch (err) {
    console.error('[api/agents] GET error:', err);
    return Response.json({ error: 'Failed to list agents' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// POST /api/agents - Create a new agent
//
// Body: { name, org, template, connector?, botToken?, chatId?, allowedUser? }
//
// `connector` defaults to 'telegram' for back-compat with pre-PR-#17 clients.
// `botToken` + `chatId` are required ONLY when `connector === 'telegram'`;
// for `connector: 'none'` they're rejected (no .env stub written either).
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { name, org, template, connector, botToken, chatId, allowedUser } = body as {
    name?: string;
    org?: string;
    template?: string;
    connector?: string;
    botToken?: string;
    chatId?: string;
    allowedUser?: string;
  };

  // --- Validation ---

  if (!name || typeof name !== 'string') {
    return Response.json({ error: 'name is required' }, { status: 400 });
  }
  if (!VALID_NAME.test(name)) {
    return Response.json(
      { error: 'name must match /^[a-z0-9_-]+$/' },
      { status: 400 },
    );
  }
  if (!org || typeof org !== 'string') {
    return Response.json({ error: 'org is required' }, { status: 400 });
  }
  // Security (C4): Validate org against allowlist before use in path.join and shell commands.
  if (!VALID_NAME.test(org)) {
    return Response.json(
      { error: 'org must match /^[a-z0-9_-]+$/' },
      { status: 400 },
    );
  }
  if (!template || !VALID_TEMPLATES.includes(template)) {
    return Response.json(
      { error: `template must be one of: ${VALID_TEMPLATES.join(', ')}` },
      { status: 400 },
    );
  }
  // Connector defaults to 'telegram' so older clients (and curl flows that
  // omit the field) still succeed with today's semantics.
  const connectorKind: ConnectorKind = (connector as ConnectorKind | undefined) ?? 'telegram';
  if (!VALID_CONNECTORS.includes(connectorKind)) {
    return Response.json(
      { error: `connector must be one of: ${VALID_CONNECTORS.join(', ')}` },
      { status: 400 },
    );
  }
  // Credentials are required for Telegram only. Reject them outright on
  // 'none' so callers can't accidentally leak BOT_TOKEN into a backend
  // agent's .env file.
  if (connectorKind === 'telegram') {
    if (!botToken || typeof botToken !== 'string') {
      return Response.json({ error: 'botToken is required for the telegram connector' }, { status: 400 });
    }
    if (!chatId || typeof chatId !== 'string') {
      return Response.json({ error: 'chatId is required for the telegram connector' }, { status: 400 });
    }
    // Reject CR/LF in credentials before they hit template-literal
    // interpolation in the .env writer. The CLI's `setup.ts:writeAgentEnv`
    // has the same guard; without it here a crafted token could smuggle
    // additional env vars via `\n` (Codex review of #26).
    if (/[\r\n]/.test(botToken)) {
      return Response.json({ error: 'botToken must not contain newline characters' }, { status: 400 });
    }
    if (/[\r\n]/.test(chatId)) {
      return Response.json({ error: 'chatId must not contain newline characters' }, { status: 400 });
    }
    if (allowedUser && typeof allowedUser === 'string' && /[\r\n]/.test(allowedUser)) {
      return Response.json({ error: 'allowedUser must not contain newline characters' }, { status: 400 });
    }
  } else {
    if (botToken !== undefined || chatId !== undefined) {
      return Response.json(
        { error: `botToken / chatId not accepted for connector: '${connectorKind}'` },
        { status: 400 },
      );
    }
  }

  const frameworkRoot = getFrameworkRoot();
  const ctxRoot = getCTXRoot();
  const enabledAgentsPath = path.join(ctxRoot, 'config', 'enabled-agents.json');

  // Check for duplicate name in enabled-agents.json
  try {
    const raw = await fs.readFile(enabledAgentsPath, 'utf-8');
    const existing = JSON.parse(raw);
    if (existing[name]) {
      return Response.json(
        { error: `Agent "${name}" already exists` },
        { status: 409 },
      );
    }
  } catch {
    // File doesn't exist yet - that's fine, we'll create it
  }

  try {
    // 1. Copy template dir to orgs/{org}/agents/{name}/
    const templateDir = path.join(frameworkRoot, 'templates', template);
    const agentDir = path.join(frameworkRoot, 'orgs', org, 'agents', name);

    await fs.mkdir(agentDir, { recursive: true });
    await copyDir(templateDir, agentDir);

    // 2. Write .env file — only for connectors with credentials. `none`
    //    agents skip this entirely (matches the CLI's add-agent behavior
    //    after PR #21 / issue #7).
    if (connectorKind === 'telegram') {
      const envLines = [
        `BOT_TOKEN=${botToken}`,
        `CHAT_ID=${chatId}`,
      ];
      if (allowedUser) {
        envLines.push(`ALLOWED_USER=${allowedUser}`);
      }
      await fs.writeFile(path.join(agentDir, '.env'), envLines.join('\n') + '\n', 'utf-8');
    }

    // 2b. Persist the connector kind to config.json so the daemon's
    //     legacy-inference path doesn't have to guess. Read-merge-write so
    //     we don't trample whatever the template's config.json already had.
    const configPath = path.join(agentDir, 'config.json');
    try {
      const existingCfg = JSON.parse(await fs.readFile(configPath, 'utf-8'));
      existingCfg.connector = connectorKind;
      await fs.writeFile(configPath, JSON.stringify(existingCfg, null, 2) + '\n', 'utf-8');
    } catch {
      // Template had no config.json or it was unreadable — write a minimal
      // one so the connector field is still present.
      const minimal = { agent_name: name, connector: connectorKind, enabled: true };
      await fs.writeFile(configPath, JSON.stringify(minimal, null, 2) + '\n', 'utf-8');
    }

    // 3. Create state dirs under CTX_ROOT
    const stateDirs = ['inbox', 'outbox', 'processed', 'inflight', 'logs', 'state'];
    for (const dir of stateDirs) {
      await fs.mkdir(path.join(ctxRoot, dir, name), { recursive: true });
    }

    // 4. Register with daemon via IPC (replaces Mac-only generate-launchd.sh + launchctl)
    const instanceId = process.env.CTX_INSTANCE_ID ?? 'default';
    const ipc = new IPCClient(instanceId);
    const daemonRunning = await ipc.isDaemonRunning();
    if (daemonRunning) {
      const ipcResult = await ipc.send({
        type: 'start-agent',
        agent: name,
        data: { dir: agentDir },
      });
      if (!ipcResult.success) {
        console.warn(`[api/agents] POST: daemon start-agent returned error for "${name}":`, ipcResult.error);
      }
    } else {
      console.info(`[api/agents] POST: daemon not running; "${name}" registered and will start with daemon.`);
    }

    // 5. Update enabled-agents.json
    let enabledAgents: Record<string, unknown> = {};
    try {
      const raw = await fs.readFile(enabledAgentsPath, 'utf-8');
      enabledAgents = JSON.parse(raw);
    } catch {
      // Start fresh
    }

    enabledAgents[name] = {
      enabled: true,
      org,
      template,
      connector: connectorKind,
      createdAt: new Date().toISOString(),
    };

    await fs.mkdir(path.dirname(enabledAgentsPath), { recursive: true });
    await fs.writeFile(
      enabledAgentsPath,
      JSON.stringify(enabledAgents, null, 2) + '\n',
      'utf-8',
    );

    return Response.json({ success: true, agent: { name, org } }, { status: 201 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[api/agents] POST error:', message);
    return Response.json(
      { error: 'Failed to create agent' },
      { status: 500 },
    );
  }
}

// ---------------------------------------------------------------------------
// Recursive directory copy
// ---------------------------------------------------------------------------

async function copyDir(src: string, dest: string): Promise<void> {
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await fs.mkdir(destPath, { recursive: true });
      await copyDir(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}
