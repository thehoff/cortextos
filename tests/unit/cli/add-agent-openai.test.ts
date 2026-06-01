/**
 * `cortextos add-agent --template agent-thin` must produce a properly-
 * scaffolded openai-compatible agent with the following properties:
 *
 * 1. config.json: enabled=true, runtime=openai-compatible, endpoint+model present
 * 2. enabled-agents.json: enabled=true (dispatch case + allowlist exist as of PR2)
 * 3. NO `.env` (no Telegram path)
 * 4. NO `.claude/skills/` (no Claude tooling)
 * 5. Template auto-infer: `--template agent-thin` implies `--runtime openai-compatible`
 * 6. Reverse auto-infer: `--runtime openai-compatible` with the default agent template
 *    uses the agent-thin template dir (matches the agent-codex precedent at
 *    add-agent.ts:102).
 *
 * History: PR1 wrote enabled=false in both files as a belt-and-braces measure
 * because the daemon dispatch case for openai-compatible didn't yet exist
 * (only the dispatch-allowlist guard). PR2 ships the OpenAICompatiblePTY
 * adapter and adds 'openai-compatible' to the allowlist, so the agent can
 * register enabled at creation time.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { addAgentCommand } from '../../../src/cli/add-agent';

describe('PR1: add-agent --template agent-thin / --runtime openai-compatible', () => {
  let tempRoot: string;
  let tempHome: string;
  let originalHome: string | undefined;
  let originalCwd: string | undefined;
  let originalFrameworkRoot: string | undefined;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'pr1-thin-'));
    tempHome = mkdtempSync(join(tmpdir(), 'pr1-thin-home-'));

    originalHome = process.env.HOME;
    originalCwd = process.env.CTX_PROJECT_ROOT;
    originalFrameworkRoot = process.env.CTX_FRAMEWORK_ROOT;
    process.env.HOME = tempHome;
    process.env.CTX_FRAMEWORK_ROOT = tempRoot;
    process.env.CTX_PROJECT_ROOT = tempRoot;

    const realTemplates = join(__dirname, '..', '..', '..', 'templates');
    symlinkSync(realTemplates, join(tempRoot, 'templates'), 'dir');

    mkdirSync(join(tempRoot, 'orgs', 'testorg', 'agents'), { recursive: true });
    writeFileSync(
      join(tempRoot, 'orgs', 'testorg', 'context.json'),
      JSON.stringify({
        name: 'testorg',
        timezone: 'America/New_York',
        orchestrator: 'orch',
        dashboard_url: 'http://localhost:3000',
        communication_style: 'casual',
        day_mode_start: '08:00',
        day_mode_end: '00:00',
      }),
    );
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    process.env.CTX_PROJECT_ROOT = originalCwd;
    process.env.CTX_FRAMEWORK_ROOT = originalFrameworkRoot;
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(tempHome, { recursive: true, force: true });
  });

  it('scaffolds agent-thin file layout without .env or .claude/skills', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await addAgentCommand.parseAsync([
      'node', 'cli', 'rag-1', '--template', 'agent-thin',
      '--org', 'testorg', '--instance', 'pr1-thin-test',
    ]);

    const agentDir = join(tempRoot, 'orgs', 'testorg', 'agents', 'rag-1');
    expect(existsSync(agentDir)).toBe(true);

    for (const f of ['AGENTS.md', 'IDENTITY.md', 'SYSTEM_PROMPT.md', 'config.json']) {
      expect(existsSync(join(agentDir, f))).toBe(true);
    }

    expect(existsSync(join(agentDir, '.env'))).toBe(false);
    expect(existsSync(join(agentDir, '.claude'))).toBe(false);
  });

  it('writes enabled=true and runtime=openai-compatible into config.json', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await addAgentCommand.parseAsync([
      'node', 'cli', 'rag-cfg', '--template', 'agent-thin',
      '--org', 'testorg', '--instance', 'pr1-thin-test',
    ]);

    const cfgPath = join(tempRoot, 'orgs', 'testorg', 'agents', 'rag-cfg', 'config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    expect(cfg.runtime).toBe('openai-compatible');
    expect(cfg.enabled).toBe(true);
    expect(cfg.agent_name).toBe('rag-cfg');
    expect(typeof cfg.endpoint).toBe('string');
    expect(typeof cfg.model).toBe('string');
  });

  it('writes enabled=true into enabled-agents.json (matches config.json posture)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await addAgentCommand.parseAsync([
      'node', 'cli', 'rag-reg', '--template', 'agent-thin',
      '--org', 'testorg', '--instance', 'pr1-thin-test',
    ]);

    const registryPath = join(tempHome, '.cortextos', 'pr1-thin-test', 'config', 'enabled-agents.json');
    expect(existsSync(registryPath)).toBe(true);

    const registry = JSON.parse(readFileSync(registryPath, 'utf-8'));
    expect(registry['rag-reg']).toBeDefined();
    expect(registry['rag-reg'].enabled).toBe(true);
    expect(registry['rag-reg'].org).toBe('testorg');
  });

  it('infers runtime=openai-compatible when --template agent-thin and no explicit --runtime', async () => {
    // The user passes only --template agent-thin; runtime should be auto-set.
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await addAgentCommand.parseAsync([
      'node', 'cli', 'rag-infer', '--template', 'agent-thin',
      '--org', 'testorg', '--instance', 'pr1-thin-test',
    ]);

    const cfg = JSON.parse(readFileSync(
      join(tempRoot, 'orgs', 'testorg', 'agents', 'rag-infer', 'config.json'),
      'utf-8',
    ));
    expect(cfg.runtime).toBe('openai-compatible');
  });

  it('uses templates/agent-thin/ when --runtime openai-compatible is supplied with default --template agent', async () => {
    // Reverse direction: runtime supplied, template should map to agent-thin.
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await addAgentCommand.parseAsync([
      'node', 'cli', 'rag-rev', '--runtime', 'openai-compatible',
      '--org', 'testorg', '--instance', 'pr1-thin-test',
    ]);

    // AGENTS.md from templates/agent-thin/ has a distinctive header — pin against it.
    const agentsMd = readFileSync(
      join(tempRoot, 'orgs', 'testorg', 'agents', 'rag-rev', 'AGENTS.md'),
      'utf-8',
    );
    expect(agentsMd).toMatch(/OpenAI-compatible specialist/);
  });

  it.each([
    ['orchestrator'],
    ['analyst'],
    ['m2c1-worker'],
    ['hermes'],
    ['agent-codex'],
  ])('rejects --runtime openai-compatible paired with --template %s', async (template) => {
    // Mirrors the codex NON_CODEX_TEMPLATES check — pairing openai-compatible
    // with a non-thin template would copy a scaffold whose config.json /
    // skill layout doesn't match the openai-compatible runtime.
    // agent-codex specifically is excluded because its config.json has
    // codex-app-server runtime hard-coded — pairing it with --runtime
    // openai-compatible would copy a scaffold whose runtime conflicts.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(addAgentCommand.parseAsync([
      'node', 'cli', `rag-bad-${template}`, '--runtime', 'openai-compatible',
      '--template', template,
      '--org', 'testorg', '--instance', 'pr1-thin-test',
    ])).rejects.toThrow(/process.exit\(1\)/);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`no openai-compatible variant of "${template}"`)),
    );

    exitSpy.mockRestore();
  });

  it('accepts all four valid runtime values', async () => {
    // VALID_RUNTIMES regression — openai-compatible must be on the list.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(addAgentCommand.parseAsync([
      'node', 'cli', 'rag-invalid', '--runtime', 'imaginary-runtime',
      '--org', 'testorg', '--instance', 'pr1-thin-test',
    ])).rejects.toThrow(/process.exit\(1\)/);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/openai-compatible.*got "imaginary-runtime"/),
    );

    exitSpy.mockRestore();
  });
});
