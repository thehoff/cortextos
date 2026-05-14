/**
 * PR6 (MCP dashboard): GET /api/mcp-servers/[name] route tests.
 *
 * Pins:
 *   - 200 with static details when the server exists.
 *   - 404 when it doesn't.
 *   - 400 on bad name shape.
 *   - DOES NOT execute the MCP server (Codex pass-1 PR6-008).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let tmp: string;
const mockFrameworkRoot = { value: '' };
vi.mock('@/lib/config', () => ({
  getFrameworkRoot: () => mockFrameworkRoot.value,
  getCTXRoot: () => mockFrameworkRoot.value,
}));
// Mock auth so importing the parent route (which transitively imports
// next-auth) doesn't fail in the test environment.
vi.mock('@/lib/auth', () => ({ auth: () => ({ user: { id: 'u' } }) }));

type RouteModule = typeof import('../route');
let route: RouteModule;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'pr6-detail-'));
  mockFrameworkRoot.value = tmp;
  mkdirSync(join(tmp, 'mcp-servers'), { recursive: true });
  route = await import('../route');
});

afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
});

function getReq(name: string): { req: NextRequest; ctx: { params: Promise<{ name: string }> } } {
  return {
    req: new NextRequest(`http://localhost:3000/api/mcp-servers/${encodeURIComponent(name)}`),
    ctx: { params: Promise.resolve({ name: encodeURIComponent(name) }) },
  };
}

describe('GET /api/mcp-servers/[name]', () => {
  it('returns 404 when the server does not exist', async () => {
    const { req, ctx } = getReq('nonexistent');
    const res = await route.GET(req, ctx);
    expect(res.status).toBe(404);
  });

  it('returns static details when the server exists', async () => {
    mkdirSync(join(tmp, 'mcp-servers', 'srv'), { recursive: true });
    mkdirSync(join(tmp, 'mcp-servers', 'srv', 'dist'), { recursive: true });
    writeFileSync(join(tmp, 'mcp-servers', 'srv', 'dist', 'index.js'), 'fake');
    writeFileSync(join(tmp, 'mcp-servers', 'srv', 'package.json'), JSON.stringify({
      name: 'mcp-server-srv',
      version: '0.1.0',
      description: 'demo',
    }));
    const { req, ctx } = getReq('srv');
    const res = await route.GET(req, ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.exists).toBe(true);
    expect(body.built).toBe(true);
    expect(body.packageJson).toEqual({ name: 'mcp-server-srv', version: '0.1.0', description: 'demo' });
  });

  it('returns built:false when dist/index.js is missing', async () => {
    mkdirSync(join(tmp, 'mcp-servers', 'unbuilt'), { recursive: true });
    writeFileSync(join(tmp, 'mcp-servers', 'unbuilt', 'package.json'), '{}');
    const { req, ctx } = getReq('unbuilt');
    const res = await route.GET(req, ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.exists).toBe(true);
    expect(body.built).toBe(false);
  });

  it('returns 400 on bad name shape', async () => {
    const { req } = getReq('Bad-Caps');
    const res = await route.GET(req, { params: Promise.resolve({ name: 'Bad-Caps' }) });
    expect(res.status).toBe(400);
  });

  it('returns 400 on name with path traversal characters', async () => {
    const { req } = getReq('..');
    const res = await route.GET(req, { params: Promise.resolve({ name: '..' }) });
    expect(res.status).toBe(400);
  });
});
