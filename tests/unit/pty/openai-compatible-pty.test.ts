/**
 * PR2 (openai-compatible runtime): OpenAICompatiblePTY env contract + lifecycle.
 *
 * Pins three load-bearing properties of the PTY adapter:
 *
 *   1. Env-var key set passed to the spawned runner — superset documented in
 *      PLAN.md, minus Telegram-only keys. Catches env-contract drift early
 *      so a missing CTX_* doesn't silently break the runner at boot.
 *   2. write() strips bracketed-paste markers — inject.ts wraps every
 *      injection in \x1b[200~...\x1b[201~ which would corrupt the runner's
 *      readline parsing of AGENT MESSAGE blocks if passed through verbatim.
 *   3. signalShutdown() sends SIGTERM without tearing down PTY state, while
 *      kill() does the eager teardown — distinct contracts the
 *      AgentProcess.stop() openai-compatible branch relies on.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { AgentConfig, CtxEnv } from '../../../src/types/index.js';
import { __setSpawnFnForTest } from '../../../src/pty/openai-compatible-pty.js';

interface RecordedSpawn {
  file: string;
  args: string[];
  options: { cwd?: string; env?: Record<string, string>; cols?: number; rows?: number };
}

let recordedSpawn: RecordedSpawn | null = null;
let mockPty: {
  pid: number;
  write: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  onData: ReturnType<typeof vi.fn>;
  onExit: ReturnType<typeof vi.fn>;
};

let tmpRoot: string;

beforeEach(() => {
  recordedSpawn = null;
  mockPty = {
    pid: 4242,
    write: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn(),
  };
  __setSpawnFnForTest((file, args, options) => {
    recordedSpawn = { file, args, options };
    return mockPty as any;
  });
  tmpRoot = mkdtempSync(join(tmpdir(), 'openai-pty-test-'));
});

afterEach(() => {
  __setSpawnFnForTest(null);
});

function cleanup(): void {
  rmSync(tmpRoot, { recursive: true, force: true });
}

function makeEnv(over: Partial<CtxEnv> = {}): CtxEnv {
  const projectRoot = join(tmpRoot, 'project');
  const agentDir = join(projectRoot, 'orgs', 'acme', 'agents', 'rag-1');
  mkdirSync(agentDir, { recursive: true });
  return {
    instanceId: 'inst-test',
    ctxRoot: join(tmpRoot, '.cortextos', 'inst-test'),
    frameworkRoot: projectRoot,
    agentName: 'rag-1',
    agentDir,
    org: 'acme',
    projectRoot,
    ...over,
  };
}

describe('OpenAICompatiblePTY env contract', () => {
  it('injects the documented superset of CTX_* keys + backward-compat aliases', async () => {
    const { OpenAICompatiblePTY } = await import('../../../src/pty/openai-compatible-pty.js');
    const env = makeEnv();
    const pty = new OpenAICompatiblePTY(env, {} as AgentConfig);
    await pty.spawn('fresh', '');

    expect(recordedSpawn).not.toBeNull();
    const spawnEnv = recordedSpawn!.options.env!;

    // Required CTX_* keys per PLAN.md env table.
    expect(spawnEnv['CTX_INSTANCE_ID']).toBe('inst-test');
    expect(spawnEnv['CTX_ROOT']).toBe(env.ctxRoot);
    expect(spawnEnv['CTX_FRAMEWORK_ROOT']).toBe(env.frameworkRoot);
    expect(spawnEnv['CTX_AGENT_NAME']).toBe('rag-1');
    expect(spawnEnv['CTX_ORG']).toBe('acme');
    expect(spawnEnv['CTX_AGENT_DIR']).toBe(env.agentDir);
    expect(spawnEnv['CTX_PROJECT_ROOT']).toBe(env.projectRoot);

    // Backward-compat aliases — agent-pty.ts:76-77.
    expect(spawnEnv['CRM_AGENT_NAME']).toBe('rag-1');
    expect(spawnEnv['CRM_TEMPLATE_ROOT']).toBe(env.frameworkRoot);

    cleanup();
  });

  it('exposes exactly the PLAN.md CTX_/CRM_ key set — no extras, no Telegram leakage', async () => {
    const { OpenAICompatiblePTY } = await import('../../../src/pty/openai-compatible-pty.js');
    const env = makeEnv();
    // No timezone, no org context, no secrets.env present — produces the
    // minimal-but-complete CTX_/CRM_ surface that the PLAN.md table pins.
    const pty = new OpenAICompatiblePTY(env, {} as AgentConfig);
    await pty.spawn('fresh', '');
    const spawnEnv = recordedSpawn!.options.env!;

    // Negative assertion: the full set of CTX_/CRM_ keys that should EVER
    // appear under the openai-compatible runtime is documented here. Any
    // future addition or typo (`CTX_ORCHESTRATOR` instead of
    // `CTX_ORCHESTRATOR_AGENT`, etc.) shows up here as an unexpected key.
    const allowedCtxKeys = new Set([
      'CTX_INSTANCE_ID',
      'CTX_ROOT',
      'CTX_FRAMEWORK_ROOT',
      'CTX_AGENT_NAME',
      'CTX_ORG',
      'CTX_AGENT_DIR',
      'CTX_PROJECT_ROOT',
      // Conditional: only when config.timezone or process.env.TZ is set.
      'CTX_TIMEZONE',
      // Conditional: only when org context.json has an orchestrator field.
      'CTX_ORCHESTRATOR_AGENT',
    ]);
    const allowedCrmKeys = new Set(['CRM_AGENT_NAME', 'CRM_TEMPLATE_ROOT']);

    const actualCtxKeys = Object.keys(spawnEnv).filter(k => k.startsWith('CTX_'));
    const actualCrmKeys = Object.keys(spawnEnv).filter(k => k.startsWith('CRM_'));

    for (const k of actualCtxKeys) {
      expect(allowedCtxKeys, `unexpected CTX_ key leaked into spawn env: ${k}`).toContain(k);
    }
    for (const k of actualCrmKeys) {
      expect(allowedCrmKeys, `unexpected CRM_ key leaked into spawn env: ${k}`).toContain(k);
    }
    cleanup();
  });

  it('falls back to process.env.TZ when config.timezone is absent', async () => {
    const { OpenAICompatiblePTY } = await import('../../../src/pty/openai-compatible-pty.js');
    const env = makeEnv();
    const originalTZ = process.env.TZ;
    process.env.TZ = 'Europe/London';
    try {
      const pty = new OpenAICompatiblePTY(env, {} as AgentConfig);
      await pty.spawn('fresh', '');
      const spawnEnv = recordedSpawn!.options.env!;
      // PLAN.md env table: CTX_TIMEZONE = config.timezone || process.env.TZ.
      // Code path at src/pty/openai-compatible-pty.ts: if config.timezone
      // missing AND process.env.TZ set, copy TZ into CTX_TIMEZONE only.
      expect(spawnEnv['CTX_TIMEZONE']).toBe('Europe/London');
    } finally {
      if (originalTZ === undefined) delete process.env.TZ;
      else process.env.TZ = originalTZ;
    }
    cleanup();
  });

  it('does NOT inject Telegram-only keys (CHAT_ID, BOT_TOKEN, CTX_TELEGRAM_CHAT_ID)', async () => {
    const { OpenAICompatiblePTY } = await import('../../../src/pty/openai-compatible-pty.js');
    const env = makeEnv();
    const pty = new OpenAICompatiblePTY(env, {} as AgentConfig);
    await pty.spawn('fresh', '');
    const spawnEnv = recordedSpawn!.options.env!;
    expect(spawnEnv['CHAT_ID']).toBeUndefined();
    expect(spawnEnv['BOT_TOKEN']).toBeUndefined();
    expect(spawnEnv['CTX_TELEGRAM_CHAT_ID']).toBeUndefined();
    cleanup();
  });

  it('does NOT load agent-level .env (openai-compatible has no .env by design)', async () => {
    const { OpenAICompatiblePTY } = await import('../../../src/pty/openai-compatible-pty.js');
    const env = makeEnv();
    // Plant a .env in the agentDir; this PTY must ignore it (unlike AgentPTY).
    writeFileSync(join(env.agentDir, '.env'), 'SHOULD_NOT_LEAK=secret\n');
    const pty = new OpenAICompatiblePTY(env, {} as AgentConfig);
    await pty.spawn('fresh', '');
    expect(recordedSpawn!.options.env!['SHOULD_NOT_LEAK']).toBeUndefined();
    cleanup();
  });

  it('loads org-level secrets.env if present (OPENAI_API_KEY etc.)', async () => {
    const { OpenAICompatiblePTY } = await import('../../../src/pty/openai-compatible-pty.js');
    const env = makeEnv();
    const orgDir = join(env.projectRoot, 'orgs', 'acme');
    mkdirSync(orgDir, { recursive: true });
    writeFileSync(join(orgDir, 'secrets.env'), [
      '# org-wide secrets',
      'OPENAI_API_KEY=sk-shared',
      'CUSTOM_KEY=value',
      '',
    ].join('\n'));
    const pty = new OpenAICompatiblePTY(env, {} as AgentConfig);
    await pty.spawn('fresh', '');
    const spawnEnv = recordedSpawn!.options.env!;
    expect(spawnEnv['OPENAI_API_KEY']).toBe('sk-shared');
    expect(spawnEnv['CUSTOM_KEY']).toBe('value');
    cleanup();
  });

  it('sets CTX_ORCHESTRATOR_AGENT (NOT CTX_ORCHESTRATOR) from org context.json', async () => {
    const { OpenAICompatiblePTY } = await import('../../../src/pty/openai-compatible-pty.js');
    const env = makeEnv();
    const orgDir = join(env.projectRoot, 'orgs', 'acme');
    mkdirSync(orgDir, { recursive: true });
    writeFileSync(join(orgDir, 'context.json'), JSON.stringify({ orchestrator: 'commander' }));
    const pty = new OpenAICompatiblePTY(env, {} as AgentConfig);
    await pty.spawn('fresh', '');
    const spawnEnv = recordedSpawn!.options.env!;
    // The name matters — agent-pty.ts:133 uses CTX_ORCHESTRATOR_AGENT, not CTX_ORCHESTRATOR.
    // v1 plan had this wrong; v2 corrected it. Pin the correct key.
    expect(spawnEnv['CTX_ORCHESTRATOR_AGENT']).toBe('commander');
    expect(spawnEnv['CTX_ORCHESTRATOR']).toBeUndefined();
    cleanup();
  });

  it('propagates timezone from config.json to both CTX_TIMEZONE and TZ', async () => {
    const { OpenAICompatiblePTY } = await import('../../../src/pty/openai-compatible-pty.js');
    const env = makeEnv();
    const pty = new OpenAICompatiblePTY(env, { timezone: 'America/New_York' } as AgentConfig);
    await pty.spawn('fresh', '');
    const spawnEnv = recordedSpawn!.options.env!;
    expect(spawnEnv['CTX_TIMEZONE']).toBe('America/New_York');
    expect(spawnEnv['TZ']).toBe('America/New_York');
    cleanup();
  });

  it('spawns the bundled CLI via process.execPath with run-openai-agent subcommand', async () => {
    const { OpenAICompatiblePTY } = await import('../../../src/pty/openai-compatible-pty.js');
    const env = makeEnv();
    const pty = new OpenAICompatiblePTY(env, {} as AgentConfig);
    await pty.spawn('fresh', '');
    expect(recordedSpawn!.file).toBe(process.execPath);
    expect(recordedSpawn!.args[1]).toBe('run-openai-agent');
    expect(recordedSpawn!.args[0]).toMatch(/cli\.js$/);
    cleanup();
  });
});

describe('OpenAICompatiblePTY message injection', () => {
  it('write() strips bracketed-paste markers before passing to PTY', async () => {
    const { OpenAICompatiblePTY } = await import('../../../src/pty/openai-compatible-pty.js');
    const env = makeEnv();
    const pty = new OpenAICompatiblePTY(env, {} as AgentConfig);
    await pty.spawn('fresh', '');

    const wrapped = '\x1b[200~=== AGENT MESSAGE from alpha [msg_id: m1] ===\n```\nhi\n```\nReply using: cortextos bus send-message alpha normal \'<your reply>\' m1\n\x1b[201~';
    pty.write(wrapped);
    expect(mockPty.write).toHaveBeenCalledTimes(1);
    const passed = mockPty.write.mock.calls[0]![0] as string;
    expect(passed).not.toContain('\x1b[200~');
    expect(passed).not.toContain('\x1b[201~');
    expect(passed).toContain('=== AGENT MESSAGE from alpha [msg_id: m1] ===');
    expect(passed).toContain("Reply using: cortextos bus send-message alpha normal '<your reply>' m1");
    cleanup();
  });
});

describe('OpenAICompatiblePTY lifecycle', () => {
  it('signalShutdown() calls pty.kill with SIGTERM and does NOT mutate alive state', async () => {
    const { OpenAICompatiblePTY } = await import('../../../src/pty/openai-compatible-pty.js');
    const env = makeEnv();
    const pty = new OpenAICompatiblePTY(env, {} as AgentConfig);
    await pty.spawn('fresh', '');
    expect(pty.isAlive()).toBe(true);

    pty.signalShutdown();
    expect(mockPty.kill).toHaveBeenCalledWith('SIGTERM');
    // signalShutdown is graceful — _alive stays true until the runner actually
    // exits and node-pty's onExit fires. The shared stop() flow relies on
    // this: it sleeps 5s after signalShutdown, then the existing isAlive()
    // check at agent-process.ts:269 decides whether to force-kill.
    expect(pty.isAlive()).toBe(true);
    cleanup();
  });

  it('kill() tears down state and calls pty.kill with default signal', async () => {
    const { OpenAICompatiblePTY } = await import('../../../src/pty/openai-compatible-pty.js');
    const env = makeEnv();
    const pty = new OpenAICompatiblePTY(env, {} as AgentConfig);
    await pty.spawn('fresh', '');
    expect(pty.isAlive()).toBe(true);

    pty.kill();
    expect(mockPty.kill).toHaveBeenCalled();
    // kill() (no arg) is the forceful path matching AgentPTY's contract —
    // _alive flips immediately so isAlive() returns false.
    expect(pty.isAlive()).toBe(false);
    expect(pty.getPid()).toBeNull();
    cleanup();
  });

  it('getPid returns the spawned PID; getOutputBuffer is constructed with the READY bootstrap pattern', async () => {
    const { OpenAICompatiblePTY } = await import('../../../src/pty/openai-compatible-pty.js');
    const env = makeEnv();
    const pty = new OpenAICompatiblePTY(env, {} as AgentConfig);
    await pty.spawn('fresh', '');
    expect(pty.getPid()).toBe(4242);

    // Bootstrap detection: the OutputBuffer is initialized with the
    // '[openai-runner] READY' pattern. Push that string through the
    // OutputBuffer's interface (via the simulated onData callback) and
    // verify isBootstrapped() flips true.
    const onDataHandler = mockPty.onData.mock.calls[0]![0] as (data: string) => void;
    expect(pty.getOutputBuffer().isBootstrapped()).toBe(false);
    onDataHandler('some startup noise...\n[openai-runner] READY\nidle\n');
    expect(pty.getOutputBuffer().isBootstrapped()).toBe(true);
    cleanup();
  });

  it('spawn refuses to double-spawn', async () => {
    const { OpenAICompatiblePTY } = await import('../../../src/pty/openai-compatible-pty.js');
    const env = makeEnv();
    const pty = new OpenAICompatiblePTY(env, {} as AgentConfig);
    await pty.spawn('fresh', '');
    await expect(pty.spawn('fresh', '')).rejects.toThrow(/already spawned/);
    cleanup();
  });
});
