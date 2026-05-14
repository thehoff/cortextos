/**
 * PR5 (MCP support): unit tests for the MCP client wrapper.
 *
 * Uses real MCP server fixtures (via the SDK's Server class) under
 * tests/fixtures/mcp/ run in a child Node process so the test
 * exercises actual protocol behavior rather than a hand-rolled mock.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { connectMcpServer, resolveMcpServerEnv } from '../../../src/openai-runner/mcp/client';
import type { McpServerSpec } from '../../../src/openai-runner/mcp/types';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const TSX = join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const FIXTURE_DIR = join(REPO_ROOT, 'tests', 'fixtures', 'mcp');
const ECHO_FIXTURE = join(FIXTURE_DIR, 'server-echo.ts');
const HANG_FIXTURE = join(FIXTURE_DIR, 'server-hang.ts');
const BAD_NAME_FIXTURE = join(FIXTURE_DIR, 'server-bad-name.ts');
const IMAGE_FIXTURE = join(FIXTURE_DIR, 'server-image-content.ts');
const ERROR_LEAK_FIXTURE = join(FIXTURE_DIR, 'server-error-leak.ts');

describe('MCP client wrapper', { timeout: 20_000 }, () => {
  it('connects, lists tools, and round-trips a text echo call', async () => {
    const spec: McpServerSpec = { name: 'fixture', command: TSX, args: [ECHO_FIXTURE] };
    const { env } = resolveMcpServerEnv(spec, process.env);
    const client = await connectMcpServer(spec, { env, cwd: REPO_ROOT, bootTimeoutMs: 15000 });
    try {
      expect(client.tools.map(t => t.name).sort()).toEqual(['echo', 'env_peek']);
      const result = await client.call('echo', { text: 'hello-mcp' }, 5000);
      expect(result).toBe('hello-mcp');
    } finally {
      await client.disconnect();
    }
  });

  it('throws when boot times out on a server that never responds', async () => {
    const spec: McpServerSpec = { name: 'hang', command: TSX, args: [HANG_FIXTURE] };
    const { env } = resolveMcpServerEnv(spec, process.env);
    await expect(connectMcpServer(spec, { env, cwd: REPO_ROOT, bootTimeoutMs: 500 }))
      .rejects.toThrow(/boot timed out/);
  });

  it('rejects an MCP server that advertises an invalid tool name (PR5-005)', async () => {
    const spec: McpServerSpec = { name: 'badname', command: TSX, args: [BAD_NAME_FIXTURE] };
    const { env } = resolveMcpServerEnv(spec, process.env);
    await expect(connectMcpServer(spec, { env, cwd: REPO_ROOT, bootTimeoutMs: 10000 }))
      .rejects.toThrow(/valid OpenAI function name/);
  });

  it('per-call timeout aborts the call without leaking', async () => {
    const spec: McpServerSpec = { name: 'fixture', command: TSX, args: [ECHO_FIXTURE] };
    const { env } = resolveMcpServerEnv(spec, process.env);
    const client = await connectMcpServer(spec, { env, cwd: REPO_ROOT, bootTimeoutMs: 15000 });
    try {
      await expect(client.call('echo', { text: 'x' }, 1)).rejects.toBeDefined();
      // After the failure, the next call with normal timeout still works
      // (the connection wasn't poisoned).
      const result = await client.call('echo', { text: 'still-alive' }, 5000);
      expect(result).toBe('still-alive');
    } finally {
      await client.disconnect();
    }
  });

  // Codex pass-3 PR5-028: non-text MCP results are implemented but were
  // previously untested. These pin the rejection path so a future SDK
  // upgrade or transport change can't silently start forwarding image
  // bytes to the LLM (which would be tokens-wasted at best, secret
  // leakage at worst).
  it('rejects an image-only MCP tool result as unsupported non-text content (PR5-028)', async () => {
    const spec: McpServerSpec = { name: 'img', command: TSX, args: [IMAGE_FIXTURE] };
    const { env } = resolveMcpServerEnv(spec, process.env);
    const client = await connectMcpServer(spec, { env, cwd: REPO_ROOT, bootTimeoutMs: 15000 });
    try {
      await expect(client.call('image_only', {}, 5000))
        .rejects.toThrow(/unsupported non-text content/);
    } finally {
      await client.disconnect();
    }
  });

  it('rejects a mixed text+image MCP tool result as unsupported non-text content (PR5-028)', async () => {
    const spec: McpServerSpec = { name: 'img', command: TSX, args: [IMAGE_FIXTURE] };
    const { env } = resolveMcpServerEnv(spec, process.env);
    const client = await connectMcpServer(spec, { env, cwd: REPO_ROOT, bootTimeoutMs: 15000 });
    try {
      await expect(client.call('mixed', {}, 5000))
        .rejects.toThrow(/unsupported non-text content/);
    } finally {
      await client.disconnect();
    }
  });

  // Codex pass-3 PR5-029: the client surfaces isError:true MCP results as
  // a thrown Error containing the text payload. The runner (loop.ts) then
  // pipes that error through redactSecrets() so $VAR-resolved secrets in
  // the text don't reach the LLM. This unit test pins that the secret
  // value DOES flow through the raw client error (so redaction is
  // necessary upstream); the integration test pins that the runner's
  // redaction prevents the leak end-to-end.
  it('surfaces isError:true MCP result text via thrown Error so redaction can run upstream (PR5-029)', async () => {
    const spec: McpServerSpec = {
      name: 'leak', command: TSX, args: [ERROR_LEAK_FIXTURE],
      env: { MCP_LEAK_SECRET: 'sk-fake-1234' },
    };
    const { env, secrets } = resolveMcpServerEnv(spec, { ...process.env, MCP_LEAK_SECRET: 'sk-fake-1234' });
    expect(secrets.size).toBeGreaterThanOrEqual(0); // env wasn't $VAR so no tracking here
    const client = await connectMcpServer(spec, { env, cwd: REPO_ROOT, bootTimeoutMs: 15000 });
    try {
      await expect(client.call('fail_with_secret', {}, 5000))
        .rejects.toThrow(/sk-fake-1234/);
    } finally {
      await client.disconnect();
    }
  });

  it('env_peek tool sees the resolved env we passed (smoke for env wiring)', async () => {
    const spec: McpServerSpec = {
      name: 'fixture', command: TSX, args: [ECHO_FIXTURE],
      env: { MCP_FIXTURE_VAR: 'visible-to-child' },
    };
    const { env } = resolveMcpServerEnv(spec, process.env);
    const client = await connectMcpServer(spec, { env, cwd: REPO_ROOT, bootTimeoutMs: 15000 });
    try {
      const v = await client.call('env_peek', { var: 'MCP_FIXTURE_VAR' }, 5000);
      expect(v).toBe('visible-to-child');
      // And a secret from the runner that we did NOT inherit should be unset:
      const secret = await client.call('env_peek', { var: 'OPENROUTER_API_KEY' }, 5000);
      expect(secret).toBe('(unset)');
    } finally {
      await client.disconnect();
    }
  });
});

describe('resolveMcpServerEnv', () => {
  const baseSpec: McpServerSpec = { name: 'srv', command: 'node' };
  const runnerEnv: NodeJS.ProcessEnv = {
    PATH: '/usr/bin',
    HOME: '/home/test',
    USER: 'test',
    LANG: 'en_US.UTF-8',
    NODE_ENV: 'test',
    SECRET_KEY: 'sk-leakable-secret-123',
    OTHER: 'not-secret',
  };

  it('includes only the minimal allowlist when env_inherit is unset', () => {
    const { env, secrets } = resolveMcpServerEnv(baseSpec, runnerEnv);
    expect(env).toEqual({
      PATH: '/usr/bin', HOME: '/home/test', USER: 'test',
      LANG: 'en_US.UTF-8', NODE_ENV: 'test',
    });
    expect(env.SECRET_KEY).toBeUndefined();
    expect(secrets.size).toBe(0);
  });

  it('inherits the full runner env when env_inherit is true', () => {
    const { env } = resolveMcpServerEnv({ ...baseSpec, env_inherit: true }, runnerEnv);
    expect(env.SECRET_KEY).toBe('sk-leakable-secret-123');
    expect(env.OTHER).toBe('not-secret');
  });

  it('does not inherit secrets when env_inherit is false (the default)', () => {
    const { env, secrets } = resolveMcpServerEnv({ ...baseSpec, env_inherit: false }, runnerEnv);
    expect(env.SECRET_KEY).toBeUndefined();
    expect(secrets.size).toBe(0);
  });

  it('resolves $VAR references from runner env and tracks them as secrets', () => {
    const { env, secrets } = resolveMcpServerEnv(
      { ...baseSpec, env: { DB_URL: '$SECRET_KEY', INERT: 'literal' } },
      runnerEnv,
    );
    expect(env.DB_URL).toBe('sk-leakable-secret-123');
    expect(env.INERT).toBe('literal');
    expect(secrets.has('sk-leakable-secret-123')).toBe(true);
  });

  it('throws when a $VAR reference points at an unset variable', () => {
    expect(() => resolveMcpServerEnv(
      { ...baseSpec, env: { DB_URL: '$DOES_NOT_EXIST' } },
      runnerEnv,
    )).toThrow(/\$DOES_NOT_EXIST.*unset or empty/);
  });

  it('does not treat a non-matching string as a $VAR reference', () => {
    const { env, secrets } = resolveMcpServerEnv(
      { ...baseSpec, env: { DB_URL: '$$weird', QUOTED: '$lower_case', MIXED: 'pre$SECRET_KEY' } },
      runnerEnv,
    );
    expect(env.DB_URL).toBe('$$weird');
    expect(env.QUOTED).toBe('$lower_case');
    expect(env.MIXED).toBe('pre$SECRET_KEY');
    expect(secrets.size).toBe(0);
  });
});
