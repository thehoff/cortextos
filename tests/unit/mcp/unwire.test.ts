/**
 * PR6 (MCP dashboard): unit tests for src/mcp/unwire.ts.
 *
 * Mirror of scaffold-wire.test.ts coverage for the reverse operation.
 * Tests the contract that PR6's DELETE /api/agents/[name]/mcp-servers/[server]
 * route depends on: validate-before-write, atomic-rename, idempotency.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { unwireMcpServerFromAgent } from '../../../src/mcp/unwire';

describe('unwireMcpServerFromAgent', () => {
  let tmp: string;
  let configPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'mcp-unwire-'));
    configPath = join(tmp, 'config.json');
  });
  afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

  function seedConfig(servers: unknown[] | undefined): void {
    const cfg: Record<string, unknown> = {
      endpoint: 'http://localhost:8080',
      model: 'test',
    };
    if (servers !== undefined) cfg.mcp_servers = servers;
    writeFileSync(configPath, JSON.stringify(cfg));
  }

  it('removes a named entry and reports the removed shape', () => {
    seedConfig([
      { name: 'a', command: 'node', args: ['./a/dist/index.js'] },
      { name: 'b', command: 'node', args: ['./b/dist/index.js'] },
    ]);
    const r = unwireMcpServerFromAgent({ agentConfigPath: configPath, serverName: 'a' });
    expect(r.removed).toBe(true);
    expect(r.removedEntry?.name).toBe('a');
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(cfg.mcp_servers.map((e: { name: string }) => e.name)).toEqual(['b']);
  });

  it('returns removed:false when no matching entry exists', () => {
    seedConfig([{ name: 'a', command: 'node', args: ['./a.js'] }]);
    const r = unwireMcpServerFromAgent({ agentConfigPath: configPath, serverName: 'nope' });
    expect(r.removed).toBe(false);
    expect(r.removedEntry).toBeUndefined();
    // File unchanged.
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(cfg.mcp_servers.length).toBe(1);
  });

  it('drops the mcp_servers field entirely when the last entry is removed', () => {
    seedConfig([{ name: 'only', command: 'node', args: ['./only.js'] }]);
    const r = unwireMcpServerFromAgent({ agentConfigPath: configPath, serverName: 'only' });
    expect(r.removed).toBe(true);
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(cfg.mcp_servers).toBeUndefined();
    expect(cfg.endpoint).toBe('http://localhost:8080');
  });

  it('returns removed:false on a config with no mcp_servers field at all', () => {
    seedConfig(undefined);
    const r = unwireMcpServerFromAgent({ agentConfigPath: configPath, serverName: 'anything' });
    expect(r.removed).toBe(false);
  });

  it('preserves all other top-level config fields', () => {
    writeFileSync(configPath, JSON.stringify({
      endpoint: 'https://api.example.com',
      model: 'gpt-4',
      api_key_env: 'OPENROUTER_API_KEY',
      provider: 'openrouter',
      tools: ['get_current_time'],
      mcp_servers: [{ name: 'srv', command: 'node', args: ['./srv.js'] }],
    }));
    unwireMcpServerFromAgent({ agentConfigPath: configPath, serverName: 'srv' });
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(cfg.endpoint).toBe('https://api.example.com');
    expect(cfg.api_key_env).toBe('OPENROUTER_API_KEY');
    expect(cfg.tools).toEqual(['get_current_time']);
  });

  it('throws when the config file does not exist', () => {
    expect(() => unwireMcpServerFromAgent({
      agentConfigPath: join(tmp, 'missing.json'),
      serverName: 'x',
    })).toThrow(/agent config not found/);
  });

  it('throws on invalid JSON', () => {
    writeFileSync(configPath, 'not-json{');
    expect(() => unwireMcpServerFromAgent({ agentConfigPath: configPath, serverName: 'x' }))
      .toThrow(/not valid JSON/);
  });

  it('uses a unique tmp filename per call (PR6-002 concurrency guard)', () => {
    // The atomic-rename pattern uses a random suffix so concurrent calls
    // don't clobber a shared tmp file. We can't easily run two calls
    // concurrently in a unit test against the same path (they'd race on
    // the config.json state anyway), but we can verify the rename
    // pattern doesn't leak a deterministic .tmp file.
    seedConfig([{ name: 'a', command: 'node', args: ['./a.js'] }]);
    unwireMcpServerFromAgent({ agentConfigPath: configPath, serverName: 'a' });
    const leftover = readdirSync(tmp).filter(f => f.includes('.tmp'));
    expect(leftover).toEqual([]);
  });
});
