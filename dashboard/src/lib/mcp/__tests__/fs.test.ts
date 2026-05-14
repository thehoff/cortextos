/**
 * PR6 (MCP dashboard): unit tests for the dashboard-local mcp/fs helpers.
 *
 * The dashboard vendors a slim version of scaffold/wire/unwire because
 * Next.js's bundler can't follow the parent cortextos main tree's
 * .js-extensioned NodeNext imports. This suite pins the contract the
 * dashboard depends on; the cortextos main src/mcp/ tests pin the CLI's
 * authoritative implementation.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  validateMcpServerSpec,
  writeMcpScaffold,
  wireMcpServerToAgent,
  unwireMcpServerFromAgent,
  ScaffoldDestExistsError,
} from '../fs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('validateMcpServerSpec', () => {
  it('accepts a minimal valid spec', () => {
    expect(() => validateMcpServerSpec({ name: 'srv', command: 'node' })).not.toThrow();
  });
  it('rejects bad name', () => {
    expect(() => validateMcpServerSpec({ name: 'Bad-Caps', command: 'node' })).toThrow(/match \/\^/);
  });
  it('rejects empty command', () => {
    expect(() => validateMcpServerSpec({ name: 'srv', command: '' })).toThrow(/command must be/);
  });
  it('rejects args with NUL byte', () => {
    expect(() => validateMcpServerSpec({ name: 'srv', command: 'node', args: ['ok\x00bad'] })).toThrow(/no NUL/);
  });
  it('rejects bad env var name', () => {
    expect(() => validateMcpServerSpec({ name: 'srv', command: 'node', env: { 'lower': 'v' } })).toThrow(/env key/);
  });
  it('rejects tool_timeout_sec out of range', () => {
    expect(() => validateMcpServerSpec({ name: 'srv', command: 'node', tool_timeout_sec: 0 })).toThrow(/tool_timeout_sec/);
    expect(() => validateMcpServerSpec({ name: 'srv', command: 'node', tool_timeout_sec: 700 })).toThrow(/tool_timeout_sec/);
  });
  // Codex PR6-020: dashboard slim validator must mirror PR5-026/027.
  it('rejects command containing ".." (PR6-020 / PR5-026 path-traversal guard)', () => {
    expect(() => validateMcpServerSpec({ name: 'srv', command: '../../bin/node' })).toThrow(/must not contain "\.\."/);
  });
  it('rejects command ending in ".json" (PR6-020 / PR5-026 config-file guard)', () => {
    expect(() => validateMcpServerSpec({ name: 'srv', command: '/etc/some-config.json' })).toThrow(/must not end with "\.json"/);
  });
  it('rejects ".JSON" suffix case-insensitively', () => {
    expect(() => validateMcpServerSpec({ name: 'srv', command: '/tmp/x.JSON' })).toThrow(/must not end with "\.json"/);
  });
  it('rejects bare relative cwd (PR6-020 / PR5-027 explicit-relative guard)', () => {
    expect(() => validateMcpServerSpec({ name: 'srv', command: 'node', cwd: 'mcp-servers/foo' })).toThrow(/cwd must be absolute.*"\.\/" or "\.\.\/"/);
  });
  it('accepts an absolute cwd', () => {
    expect(() => validateMcpServerSpec({ name: 'srv', command: 'node', cwd: '/abs/path' })).not.toThrow();
  });
  it('accepts a "./"-prefixed cwd', () => {
    expect(() => validateMcpServerSpec({ name: 'srv', command: 'node', cwd: './sub' })).not.toThrow();
  });
  it('accepts a "../"-prefixed cwd', () => {
    expect(() => validateMcpServerSpec({ name: 'srv', command: 'node', cwd: '../sibling' })).not.toThrow();
  });
});

describe('writeMcpScaffold', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'dash-scaffold-')); });
  afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

  it('writes expected files', () => {
    const r = writeMcpScaffold({ serverName: 'srv', destDir: join(tmp, 'srv') });
    expect(r.filesWritten.length).toBe(4);
    expect(existsSync(join(tmp, 'srv', 'package.json'))).toBe(true);
    expect(existsSync(join(tmp, 'srv', 'src', 'index.ts'))).toBe(true);
  });

  it('throws ScaffoldDestExistsError when destDir exists', () => {
    mkdirSync(join(tmp, 'occupied'));
    expect(() => writeMcpScaffold({ serverName: 'occupied', destDir: join(tmp, 'occupied') }))
      .toThrow(ScaffoldDestExistsError);
  });

  it('rejects bad server name', () => {
    expect(() => writeMcpScaffold({ serverName: 'Bad-Caps', destDir: join(tmp, 'x') }))
      .toThrow(/match \/\^/);
  });
});

describe('wireMcpServerToAgent', () => {
  let tmp: string;
  let configPath: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'dash-wire-'));
    configPath = join(tmp, 'config.json');
    writeFileSync(configPath, JSON.stringify({ endpoint: 'http://x', model: 'm' }));
  });
  afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

  it('adds an entry', () => {
    const r = wireMcpServerToAgent({
      agentConfigPath: configPath,
      serverEntry: { name: 'srv', command: 'node', args: ['./a.js'] },
    });
    expect(r.added).toBe(true);
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(cfg.mcp_servers[0].name).toBe('srv');
  });

  it('rejects with added:false on collision unless force', () => {
    wireMcpServerToAgent({ agentConfigPath: configPath, serverEntry: { name: 'srv', command: 'node' } });
    const r = wireMcpServerToAgent({ agentConfigPath: configPath, serverEntry: { name: 'srv', command: 'changed' } });
    expect(r.added).toBe(false);
    expect(r.existingEntry?.command).toBe('node');
  });

  it('replaces on force', () => {
    wireMcpServerToAgent({ agentConfigPath: configPath, serverEntry: { name: 'srv', command: 'node' } });
    const r = wireMcpServerToAgent({
      agentConfigPath: configPath,
      serverEntry: { name: 'srv', command: 'changed' },
      force: true,
    });
    expect(r.added).toBe(true);
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(cfg.mcp_servers[0].command).toBe('changed');
  });

  it('uses a unique tmp filename per call', () => {
    wireMcpServerToAgent({ agentConfigPath: configPath, serverEntry: { name: 'srv', command: 'node' } });
    expect(readdirSync(tmp).filter(f => f.includes('.tmp'))).toEqual([]);
  });
});

describe('unwireMcpServerFromAgent', () => {
  let tmp: string;
  let configPath: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'dash-unwire-'));
    configPath = join(tmp, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      endpoint: 'http://x', model: 'm',
      mcp_servers: [{ name: 'a', command: 'node' }, { name: 'b', command: 'node' }],
    }));
  });
  afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

  it('removes a named entry', () => {
    const r = unwireMcpServerFromAgent({ agentConfigPath: configPath, serverName: 'a' });
    expect(r.removed).toBe(true);
    expect(r.removedEntry?.name).toBe('a');
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(cfg.mcp_servers.map((e: { name: string }) => e.name)).toEqual(['b']);
  });

  it('returns removed:false when not found', () => {
    expect(unwireMcpServerFromAgent({ agentConfigPath: configPath, serverName: 'nope' }).removed).toBe(false);
  });

  it('drops the field entirely on last removal', () => {
    unwireMcpServerFromAgent({ agentConfigPath: configPath, serverName: 'a' });
    unwireMcpServerFromAgent({ agentConfigPath: configPath, serverName: 'b' });
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(cfg.mcp_servers).toBeUndefined();
  });

  it('rejects unwire when tools[] still references the server (PR6-013)', () => {
    writeFileSync(configPath, JSON.stringify({
      endpoint: 'http://x', model: 'm',
      mcp_servers: [{ name: 'srv-with-tool', command: 'node' }],
      tools: ['mcp__srv_with_tool__echo'],
    }));
    expect(() => unwireMcpServerFromAgent({ agentConfigPath: configPath, serverName: 'srv-with-tool' }))
      .toThrow(/tools\[\] still references/);
    // Config untouched on rejection.
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(cfg.mcp_servers.length).toBe(1);
  });

  it('allows unwire when tools[] no longer references the server', () => {
    writeFileSync(configPath, JSON.stringify({
      endpoint: 'http://x', model: 'm',
      mcp_servers: [{ name: 'srv', command: 'node' }],
      tools: ['get_current_time'], // builtin, unrelated
    }));
    expect(() => unwireMcpServerFromAgent({ agentConfigPath: configPath, serverName: 'srv' }))
      .not.toThrow();
  });
});
