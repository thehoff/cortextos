/**
 * PR6 (MCP dashboard): DELETE /api/agents/[name]/mcp-servers/[server]
 *
 * Pins:
 *   - 200 on successful unwire, with restartRequired/restartCommand.
 *   - 404 when the entry doesn't exist.
 *   - 400 on bad agent or server name.
 *   - Removes the field entirely when the last entry is removed.
 *   - Auth gate inherited from requireWriteAuth.
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

const AGENT = 'rag-1';
const ORG = 'acme';
let configPath: string;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'pr6-unwire-'));
  mockFrameworkRoot.value = tmp;
  mockAgents.length = 0;
  mockAgents.push({ name: AGENT, org: ORG });
  const agentDir = join(tmp, 'orgs', ORG, 'agents', AGENT);
  mkdirSync(agentDir, { recursive: true });
  configPath = join(agentDir, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    endpoint: 'http://localhost:8080',
    model: 'test',
    mcp_servers: [
      { name: 'srv-a', command: 'node', args: ['./a.js'] },
      { name: 'srv-b', command: 'node', args: ['./b.js'] },
    ],
  }));
  route = await import('../route');
});

afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
});

function deleteReq(agent: string, server: string, headers: Record<string, string> = { origin: 'http://localhost:3000' }): { req: NextRequest; ctx: { params: Promise<{ name: string; server: string }> } } {
  return {
    req: new NextRequest(
      `http://localhost:3000/api/agents/${encodeURIComponent(agent)}/mcp-servers/${encodeURIComponent(server)}`,
      { method: 'DELETE', headers },
    ),
    ctx: { params: Promise.resolve({ name: encodeURIComponent(agent), server: encodeURIComponent(server) }) },
  };
}

describe('DELETE /api/agents/[name]/mcp-servers/[server]', () => {
  it('removes a named entry and returns the restart hint', async () => {
    const { req, ctx } = deleteReq(AGENT, 'srv-a');
    const res = await route.DELETE(req, ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.removed).toBe(true);
    expect(body.removedEntry.name).toBe('srv-a');
    expect(body.restartRequired).toBe(true);
    expect(body.restartCommand).toBe(`cortextos disable ${AGENT} && cortextos enable ${AGENT}`);
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(cfg.mcp_servers.map((s: { name: string }) => s.name)).toEqual(['srv-b']);
  });

  it('drops mcp_servers entirely when the last entry is removed', async () => {
    writeFileSync(configPath, JSON.stringify({
      endpoint: 'http://localhost:8080', model: 'test',
      mcp_servers: [{ name: 'only-one', command: 'node', args: ['./x.js'] }],
    }));
    const { req, ctx } = deleteReq(AGENT, 'only-one');
    await route.DELETE(req, ctx);
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(cfg.mcp_servers).toBeUndefined();
  });

  it('returns 404 when the entry does not exist', async () => {
    const { req, ctx } = deleteReq(AGENT, 'never-existed');
    const res = await route.DELETE(req, ctx);
    expect(res.status).toBe(404);
  });

  it('returns 400 on bad agent name', async () => {
    const { req, ctx } = deleteReq('Bad-Caps', 'srv-a');
    const res = await route.DELETE(req, ctx);
    expect(res.status).toBe(400);
  });

  it('returns 400 on bad server name shape', async () => {
    const { req, ctx } = deleteReq(AGENT, 'Bad-Caps');
    const res = await route.DELETE(req, ctx);
    expect(res.status).toBe(400);
  });

  it('returns 404 when the agent does not exist', async () => {
    mockAgents.length = 0;
    const { req, ctx } = deleteReq('ghost', 'srv-a');
    const res = await route.DELETE(req, ctx);
    expect(res.status).toBe(404);
  });
});
