/**
 * PR5 (MCP): unit tests for the pure-function scaffold + wire modules.
 *
 * Both modules are deliberately side-effect-light (they only touch the
 * filesystem at the paths the caller provides) so PR6's daemon HTTP
 * routes can reuse them without pulling in CLI or runner internals.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { writeMcpScaffold } from '../../../src/mcp/scaffold';
import { wireMcpServerToAgent } from '../../../src/mcp/wire';
import type { McpServerSpec } from '../../../src/openai-runner/config';

describe('writeMcpScaffold', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'mcp-scaffold-')); });
  afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

  it('writes the expected files for a valid server name', () => {
    const dest = join(tmp, 'my-mcp');
    const result = writeMcpScaffold({ serverName: 'my-mcp', destDir: dest });
    expect(result.filesWritten.length).toBe(4);
    expect(existsSync(join(dest, 'package.json'))).toBe(true);
    expect(existsSync(join(dest, 'tsconfig.json'))).toBe(true);
    expect(existsSync(join(dest, 'src', 'index.ts'))).toBe(true);
    expect(existsSync(join(dest, 'README.md'))).toBe(true);
  });

  it('renders the server name into package.json + index.ts + README', () => {
    const dest = join(tmp, 'data-oracle');
    writeMcpScaffold({ serverName: 'data-oracle', destDir: dest });
    const pkg = JSON.parse(readFileSync(join(dest, 'package.json'), 'utf-8'));
    expect(pkg.name).toBe('mcp-server-data-oracle');
    expect(pkg.dependencies['@modelcontextprotocol/sdk']).toMatch(/\^1\./);
    const indexTs = readFileSync(join(dest, 'src', 'index.ts'), 'utf-8');
    expect(indexTs).toContain("name: 'data-oracle'");
    const readme = readFileSync(join(dest, 'README.md'), 'utf-8');
    expect(readme).toContain('cortextos init-mcp data-oracle');
    expect(readme).toContain('cortextos add-mcp data-oracle --agent');
  });

  it('rejects invalid server names', () => {
    expect(() => writeMcpScaffold({ serverName: 'Bad-Caps', destDir: join(tmp, 'x') }))
      .toThrow(/kebab-lowercase/);
    expect(() => writeMcpScaffold({ serverName: '9starts-digit', destDir: join(tmp, 'y') }))
      .toThrow(/kebab-lowercase/);
    expect(() => writeMcpScaffold({ serverName: 'has spaces', destDir: join(tmp, 'z') }))
      .toThrow(/kebab-lowercase/);
  });

  it('refuses to clobber an existing directory', () => {
    const dest = join(tmp, 'occupied');
    mkdirSync(dest);
    writeFileSync(join(dest, 'preexisting.txt'), 'do not delete');
    expect(() => writeMcpScaffold({ serverName: 'occupied', destDir: dest }))
      .toThrow(/already exists/);
    expect(readFileSync(join(dest, 'preexisting.txt'), 'utf-8')).toBe('do not delete');
  });
});

describe('wireMcpServerToAgent', () => {
  let tmp: string;
  let configPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'mcp-wire-'));
    configPath = join(tmp, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      endpoint: 'http://localhost:8080',
      model: 'test',
    }));
  });
  afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

  const baseEntry: McpServerSpec = { name: 'srv-one', command: 'node', args: ['./mcp-servers/srv-one/dist/index.js'] };

  it('adds a new entry when none exists', () => {
    const r = wireMcpServerToAgent({ agentConfigPath: configPath, serverEntry: baseEntry });
    expect(r.added).toBe(true);
    expect(r.existingEntry).toBeUndefined();
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(cfg.mcp_servers.length).toBe(1);
    expect(cfg.mcp_servers[0].name).toBe('srv-one');
  });

  it('returns added:false when an entry with the same name exists and force is not set', () => {
    wireMcpServerToAgent({ agentConfigPath: configPath, serverEntry: baseEntry });
    const r = wireMcpServerToAgent({ agentConfigPath: configPath, serverEntry: { ...baseEntry, command: 'changed' } });
    expect(r.added).toBe(false);
    expect(r.existingEntry?.command).toBe('node');
    // config unchanged.
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(cfg.mcp_servers[0].command).toBe('node');
  });

  it('replaces the existing entry when force is set', () => {
    wireMcpServerToAgent({ agentConfigPath: configPath, serverEntry: baseEntry });
    const r = wireMcpServerToAgent({
      agentConfigPath: configPath,
      serverEntry: { ...baseEntry, command: 'changed' },
      force: true,
    });
    expect(r.added).toBe(true);
    expect(r.existingEntry?.command).toBe('node');
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(cfg.mcp_servers[0].command).toBe('changed');
    expect(cfg.mcp_servers.length).toBe(1);
  });

  it('throws if validateConfig rejects the merged config', () => {
    expect(() => wireMcpServerToAgent({
      agentConfigPath: configPath,
      serverEntry: { ...baseEntry, name: 'Bad-Caps' as string } as McpServerSpec,
    })).toThrow(/match \/\^/);
    // original file unchanged (no .wire-tmp leftover)
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(cfg.mcp_servers).toBeUndefined();
  });

  it('preserves other top-level fields in config.json', () => {
    // Write a richer config.
    writeFileSync(configPath, JSON.stringify({
      endpoint: 'https://api.example.com',
      model: 'gpt-4',
      api_key_env: 'MY_KEY',
      provider: 'openrouter',
      tools: ['get_current_time'],
    }));
    wireMcpServerToAgent({ agentConfigPath: configPath, serverEntry: baseEntry });
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(cfg.endpoint).toBe('https://api.example.com');
    expect(cfg.api_key_env).toBe('MY_KEY');
    expect(cfg.provider).toBe('openrouter');
    expect(cfg.tools).toEqual(['get_current_time']);
    expect(cfg.mcp_servers[0].name).toBe('srv-one');
  });

  it('throws when the config file is not valid JSON', () => {
    writeFileSync(configPath, 'not-json{{');
    expect(() => wireMcpServerToAgent({ agentConfigPath: configPath, serverEntry: baseEntry }))
      .toThrow(/not valid JSON/);
  });

  it('throws when the config file does not exist', () => {
    expect(() => wireMcpServerToAgent({
      agentConfigPath: join(tmp, 'does-not-exist.json'),
      serverEntry: baseEntry,
    })).toThrow(/agent config not found/);
  });
});
