import { NextRequest } from 'next/server';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getFrameworkRoot, resolveAgentDir } from '@/lib/config';
import { spawnSync } from 'child_process';

export const dynamic = 'force-dynamic';

// Shared with the system-prompt route via resolveAgentDir so both resolve the
// same agent directory (council review: de-duplicated the path resolver).
function resolveAgentConfigPath(name: string): string | null {
  const dir = resolveAgentDir(name);
  return dir ? join(dir, 'config.json') : null;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  if (!/^[a-z0-9_-]+$/.test(name)) {
    return Response.json({ error: 'Invalid agent name' }, { status: 400 });
  }
  const configPath = resolveAgentConfigPath(name);
  if (!configPath) {
    return Response.json({ error: 'Agent config not found' }, { status: 404 });
  }
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    return Response.json({ config, name });
  } catch {
    return Response.json({ error: 'Failed to read config' }, { status: 500 });
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  if (!/^[a-z0-9_-]+$/.test(name)) {
    return Response.json({ error: 'Invalid agent name' }, { status: 400 });
  }
  const frameworkRoot = getFrameworkRoot();
  const configPath = resolveAgentConfigPath(name);
  if (!configPath) {
    return Response.json({ error: 'Agent config not found' }, { status: 404 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const allowed = ['timezone', 'day_mode_start', 'day_mode_end', 'communication_style', 'approval_rules', 'max_session_seconds', 'max_crashes_per_day', 'startup_delay', 'model', 'ctx_warning_threshold', 'ctx_handoff_threshold', 'runtime', 'endpoint', 'api_key_env'];
  const timeRegex = /^\d{2}:\d{2}$/;

  // Runtime + openai-compatible local-LLM fields.
  const RUNTIMES = ['claude-code', 'codex-app-server', 'hermes', 'openai-compatible'];
  if (body.runtime !== undefined && !RUNTIMES.includes(body.runtime as string)) {
    return Response.json({ error: `runtime must be one of ${RUNTIMES.join(', ')}` }, { status: 400 });
  }
  for (const strField of ['endpoint', 'api_key_env'] as const) {
    if (body[strField] !== undefined && typeof body[strField] !== 'string') {
      return Response.json({ error: `${strField} must be a string` }, { status: 400 });
    }
  }
  if (body.endpoint !== undefined && body.endpoint !== '' && !/^https?:\/\//.test(body.endpoint as string)) {
    return Response.json({ error: 'endpoint must be an http(s) URL' }, { status: 400 });
  }
  if (body.day_mode_start && !timeRegex.test(body.day_mode_start as string)) {
    return Response.json({ error: 'day_mode_start must be HH:MM' }, { status: 400 });
  }
  if (body.day_mode_end && !timeRegex.test(body.day_mode_end as string)) {
    return Response.json({ error: 'day_mode_end must be HH:MM' }, { status: 400 });
  }

  // Validate approval_rules shape
  if (body.approval_rules !== undefined) {
    const ar = body.approval_rules as Record<string, unknown>;
    const isStringArray = (v: unknown) => Array.isArray(v) && (v as unknown[]).every(el => typeof el === 'string' && el.length > 0);
    if (
      typeof ar !== 'object' || ar === null || Array.isArray(ar) ||
      !isStringArray(ar.always_ask) || !isStringArray(ar.never_ask)
    ) {
      return Response.json(
        { error: 'approval_rules must have shape { always_ask: string[], never_ask: string[] } with non-empty string elements' },
        { status: 400 },
      );
    }
  }

  // Validate context threshold fields: must be numbers between 50 and 95
  for (const pctField of ['ctx_warning_threshold', 'ctx_handoff_threshold'] as const) {
    if (body[pctField] !== undefined) {
      const val = body[pctField];
      if (typeof val !== 'number' || val < 50 || val > 95) {
        return Response.json({ error: `${pctField} must be a number between 50 and 95` }, { status: 400 });
      }
    }
  }
  if (body.ctx_warning_threshold !== undefined && body.ctx_handoff_threshold !== undefined) {
    if ((body.ctx_warning_threshold as number) >= (body.ctx_handoff_threshold as number)) {
      return Response.json({ error: 'ctx_warning_threshold must be less than ctx_handoff_threshold' }, { status: 400 });
    }
  }

  // Validate numeric fields: must be non-negative integers
  for (const numField of ['max_session_seconds', 'max_crashes_per_day', 'startup_delay'] as const) {
    if (body[numField] !== undefined) {
      const val = body[numField];
      if (typeof val !== 'number' || !Number.isInteger(val) || val < 0) {
        return Response.json(
          { error: `${numField} must be a non-negative integer` },
          { status: 400 },
        );
      }
    }
  }

  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    for (const key of allowed) {
      if (body[key] !== undefined) config[key] = body[key];
    }
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');

    // Notify agent immediately (non-fatal if offline)
    try {
      const sendMsg = join(frameworkRoot, 'bus', 'send-message.sh');
      if (existsSync(sendMsg)) {
        spawnSync(
          'bash',
          [sendMsg, name, 'normal', 'Settings updated via dashboard. Re-read config.json and apply new operational settings.'],
          {
            env: { ...process.env, CTX_FRAMEWORK_ROOT: frameworkRoot, CTX_AGENT_NAME: name },
            timeout: 5000,
            stdio: 'pipe',
          },
        );
      }
    } catch (notifyErr) {
      console.error(`[api/agents/${name}/config] PATCH: send-message.sh failed (non-fatal):`, notifyErr);
    }

    return Response.json({ success: true, config, name });
  } catch {
    return Response.json({ error: 'Failed to write config' }, { status: 500 });
  }
}
