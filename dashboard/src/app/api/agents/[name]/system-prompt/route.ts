import { NextRequest } from 'next/server';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { resolveAgentDir } from '@/lib/config';

export const dynamic = 'force-dynamic';

// Per-agent system prompt lives in the agent dir as SYSTEM_PROMPT.md — the same
// file the runtimes consume (claude-code via --append-system-prompt; the
// openai-compatible runner reads it directly in run-openai-agent.ts). Editing it
// here keeps cortextOS as the single source of truth (council vote A).

export async function GET(_request: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  if (!/^[a-z0-9_-]+$/.test(name)) return Response.json({ error: 'Invalid agent name' }, { status: 400 });
  const dir = resolveAgentDir(name);
  if (!dir) return Response.json({ error: 'Agent not found' }, { status: 404 });
  const p = join(dir, 'SYSTEM_PROMPT.md');
  const systemPrompt = existsSync(p) ? readFileSync(p, 'utf-8') : '';
  return Response.json({ systemPrompt, name });
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  if (!/^[a-z0-9_-]+$/.test(name)) return Response.json({ error: 'Invalid agent name' }, { status: 400 });
  let body: { content?: unknown };
  try { body = await request.json(); } catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }); }
  if (typeof body.content !== 'string') return Response.json({ error: 'content must be a string' }, { status: 400 });
  if (body.content.length > 200_000) return Response.json({ error: 'content too large' }, { status: 400 });

  const dir = resolveAgentDir(name);
  if (!dir) return Response.json({ error: 'Agent not found' }, { status: 404 });
  try {
    writeFileSync(join(dir, 'SYSTEM_PROMPT.md'), body.content, 'utf-8');
    return Response.json({ success: true, name });
  } catch {
    return Response.json({ error: 'Failed to write system prompt' }, { status: 500 });
  }
}
