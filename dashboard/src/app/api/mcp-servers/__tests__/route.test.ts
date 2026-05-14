/**
 * PR6 (MCP dashboard): GET + POST /api/mcp-servers route tests.
 *
 * Pins:
 *   - GET returns the scaffold inventory (entries with built status).
 *   - POST scaffolds via the pure-function module (happy path).
 *   - POST returns 409 on dest already exists.
 *   - POST returns 400 on bad name / non-JSON body.
 *   - POST returns 401 without auth, 403 on bad Origin (cookie-auth).
 *
 * Mocks auth() + getFrameworkRoot so tests don't depend on a real
 * NextAuth session or a real cortextos project on disk.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mocks must be registered before route import.
const mockAuth = vi.fn();
vi.mock('@/lib/auth', () => ({ auth: () => mockAuth() }));

const mockFrameworkRoot = { value: '' };
vi.mock('@/lib/config', () => ({
  getFrameworkRoot: () => mockFrameworkRoot.value,
  getCTXRoot: () => mockFrameworkRoot.value,
}));

type RouteModule = typeof import('../route');
let route: RouteModule;

let tmp: string;

beforeEach(async () => {
  mockAuth.mockReset();
  mockAuth.mockResolvedValue({ user: { id: 'u', email: 't@example.com' } });
  tmp = mkdtempSync(join(tmpdir(), 'pr6-route-'));
  mockFrameworkRoot.value = tmp;
  mkdirSync(join(tmp, 'mcp-servers'), { recursive: true });
  route = await import('../route');
});

afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
});

function postReq(body: unknown, headers: Record<string, string> = { origin: 'http://localhost:3000' }): NextRequest {
  return new NextRequest('http://localhost:3000/api/mcp-servers', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('GET /api/mcp-servers', () => {
  it('returns an empty list when the directory is empty', async () => {
    const res = await route.GET();
    const body = await res.json();
    expect(body.servers).toEqual([]);
  });

  it('lists existing scaffold directories with built status', async () => {
    mkdirSync(join(tmp, 'mcp-servers', 'srv-a', 'dist'), { recursive: true });
    writeFileSync(join(tmp, 'mcp-servers', 'srv-a', 'dist', 'index.js'), 'fake');
    writeFileSync(join(tmp, 'mcp-servers', 'srv-a', 'package.json'), '{"name":"x"}');
    mkdirSync(join(tmp, 'mcp-servers', 'srv-b'), { recursive: true });
    // srv-b has no dist/ → built:false
    const res = await route.GET();
    const body = await res.json();
    expect(body.servers.map((s: { name: string }) => s.name).sort()).toEqual(['srv-a', 'srv-b']);
    const a = body.servers.find((s: { name: string }) => s.name === 'srv-a');
    expect(a.built).toBe(true);
    expect(a.hasPackageJson).toBe(true);
    const b = body.servers.find((s: { name: string }) => s.name === 'srv-b');
    expect(b.built).toBe(false);
  });

  it('returns empty list when mcp-servers/ does not exist', async () => {
    rmSync(join(tmp, 'mcp-servers'), { recursive: true });
    const res = await route.GET();
    expect((await res.json()).servers).toEqual([]);
  });
});

describe('POST /api/mcp-servers', () => {
  it('scaffolds successfully and returns 201 with file list', async () => {
    const res = await route.POST(postReq({ name: 'time-oracle' }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.created).toBe(true);
    expect(body.files.length).toBeGreaterThanOrEqual(3);
    expect(body.buildHint).toMatch(/cd .* && npm install && npm run build/);
  });

  it('returns 409 when the destination already exists', async () => {
    mkdirSync(join(tmp, 'mcp-servers', 'conflict'));
    const res = await route.POST(postReq({ name: 'conflict' }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/already exists/);
  });

  it('returns 400 on bad name shape', async () => {
    const res = await route.POST(postReq({ name: 'Bad-Caps' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/^name must match/);
  });

  it('returns 400 on missing name', async () => {
    const res = await route.POST(postReq({}));
    expect(res.status).toBe(400);
  });

  it('returns 400 on non-JSON body', async () => {
    const res = await route.POST(postReq('not-json{'));
    expect(res.status).toBe(400);
  });

  it('returns 401 when no session', async () => {
    mockAuth.mockResolvedValueOnce(null);
    const res = await route.POST(postReq({ name: 'srv' }));
    expect(res.status).toBe(401);
  });

  it('returns 403 when cookie-auth lacks an Origin header', async () => {
    const res = await route.POST(postReq({ name: 'srv' }, { /* no origin */ }));
    expect(res.status).toBe(403);
  });

  it('returns 403 when Origin is not in the allowlist', async () => {
    const res = await route.POST(postReq({ name: 'srv' }, { origin: 'https://evil.example' }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/not allowed/);
  });

  it('accepts bearer-authed requests without an Origin header', async () => {
    const res = await route.POST(new NextRequest('http://localhost:3000/api/mcp-servers', {
      method: 'POST',
      body: JSON.stringify({ name: 'bearer-test' }),
      headers: { 'content-type': 'application/json', authorization: 'Bearer x.y.z' },
    }));
    expect(res.status).toBe(201);
  });
});
