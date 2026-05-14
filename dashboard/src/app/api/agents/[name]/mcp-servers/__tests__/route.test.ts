/**
 * PR6 (MCP dashboard): POST /api/agents/[name]/mcp-servers route tests.
 *
 * Pins the contract:
 *   - Happy path → 201 with restartRequired/restartCommand response
 *   - Collision without force → 409 + existingEntry
 *   - Collision with force:true → 201 with replacedExisting:true
 *   - Bad agent name → 400
 *   - Agent not found → 404
 *   - Validation failure from the wire helper → 400 surfacing the
 *     config.json: error message
 *   - Auth/Origin gates
 *
 * Mocks @/lib/auth, @/lib/config to point at a tmpdir cortextos tree.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let tmp: string;
const mockFrameworkRoot = { value: '' };
const mockAgents: { name: string; org?: string | null }[] = [];

vi.mock('@/lib/auth', () => ({ auth: () => ({ user: { id: 'u' } }) }));
vi.mock('@/lib/config', () => ({
  getFrameworkRoot: () => mockFrameworkRoot.value,
  getCTXRoot: () => mockFrameworkRoot.value,
  getAllAgents: () => mockAgents,
  getAgentDir: (name: string, org?: string) =>
    org
      ? join(mockFrameworkRoot.value, 'orgs', org, 'agents', name)
      : join(mockFrameworkRoot.value, 'agents', name),
}));

type RouteModule = typeof import('../route');
let route: RouteModule;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'pr6-wire-'));
  mockFrameworkRoot.value = tmp;
  mockAgents.length = 0;
  mockAgents.push({ name: 'rag-1', org: 'acme' });
  // Seed the agent's config.json
  const agentDir = join(tmp, 'orgs', 'acme', 'agents', 'rag-1');
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, 'config.json'), JSON.stringify({
    endpoint: 'http://localhost:8080', model: 'test',
  }));
  // Seed scaffold + built dist/index.js for the servers tests will wire.
  // Codex pass-2 PR6-018: the wire route now hard-checks dist/index.js
  // existence when using the default path. Tests must seed it.
  for (const srv of ['time-oracle', 'srv-x', 'srv']) {
    const serverDir = join(tmp, 'mcp-servers', srv, 'dist');
    mkdirSync(serverDir, { recursive: true });
    writeFileSync(join(serverDir, 'index.js'), 'fake');
  }
  route = await import('../route');
});

afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
});

function postReq(agent: string, body: unknown, headers: Record<string, string> = { origin: 'http://localhost:3000' }): { req: NextRequest; ctx: { params: Promise<{ name: string }> } } {
  return {
    req: new NextRequest(`http://localhost:3000/api/agents/${encodeURIComponent(agent)}/mcp-servers`, {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...headers },
    }),
    ctx: { params: Promise.resolve({ name: encodeURIComponent(agent) }) },
  };
}

describe('POST /api/agents/[name]/mcp-servers', () => {
  it('wires a new entry and returns 201 with restart hint', async () => {
    const { req, ctx } = postReq('rag-1', { name: 'time-oracle' });
    const res = await route.POST(req, ctx);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.added).toBe(true);
    expect(body.restartRequired).toBe(true);
    expect(body.restartCommand).toBe('cortextos disable rag-1 && cortextos enable rag-1');
    // Config file actually updated.
    const cfg = JSON.parse(readFileSync(join(tmp, 'orgs', 'acme', 'agents', 'rag-1', 'config.json'), 'utf-8'));
    expect(cfg.mcp_servers[0].name).toBe('time-oracle');
  });

  it('returns 409 on collision without force', async () => {
    let r = await route.POST(...Object.values(postReq('rag-1', { name: 'srv-x' })) as Parameters<typeof route.POST>);
    expect(r.status).toBe(201);
    r = await route.POST(...Object.values(postReq('rag-1', { name: 'srv-x' })) as Parameters<typeof route.POST>);
    expect(r.status).toBe(409);
    const body = await r.json();
    expect(body.added).toBe(false);
    expect(body.existingEntry).toBeDefined();
  });

  it('replaces an existing entry when force:true', async () => {
    await route.POST(...Object.values(postReq('rag-1', { name: 'srv-x', command: 'node' })) as Parameters<typeof route.POST>);
    const r = await route.POST(...Object.values(postReq('rag-1', { name: 'srv-x', command: 'node-modified', force: true })) as Parameters<typeof route.POST>);
    expect(r.status).toBe(201);
    const body = await r.json();
    expect(body.added).toBe(true);
    expect(body.replacedExisting).toBe(true);
    const cfg = JSON.parse(readFileSync(join(tmp, 'orgs', 'acme', 'agents', 'rag-1', 'config.json'), 'utf-8'));
    expect(cfg.mcp_servers[0].command).toBe('node-modified');
  });

  it('returns 400 on bad agent name', async () => {
    const r = await route.POST(...Object.values(postReq('Bad-Caps', { name: 'srv' })) as Parameters<typeof route.POST>);
    expect(r.status).toBe(400);
  });

  it('returns 404 when the agent does not exist', async () => {
    mockAgents.length = 0;
    const r = await route.POST(...Object.values(postReq('ghost', { name: 'srv' })) as Parameters<typeof route.POST>);
    expect(r.status).toBe(404);
  });

  it('returns 400 when the server name is bad (validation surfaces from wire helper)', async () => {
    const r = await route.POST(...Object.values(postReq('rag-1', { name: 'Bad-Caps-srv' })) as Parameters<typeof route.POST>);
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.error).toMatch(/mcp_servers|name must/);
  });

  it('returns 401 without a session', async () => {
    vi.doMock('@/lib/auth', () => ({ auth: () => null }));
    vi.resetModules();
    const reroute = await import('../route');
    const { req, ctx } = postReq('rag-1', { name: 'srv' });
    const r = await reroute.POST(req, ctx);
    expect(r.status).toBe(401);
    vi.doUnmock('@/lib/auth');
    vi.resetModules();
  });
});
