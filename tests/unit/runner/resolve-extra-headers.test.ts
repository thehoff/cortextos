/**
 * PR4 (provider polish): effective-header materialization.
 *
 * resolveExtraHeaders() merges provider-specific defaults with the
 * operator's `headers` map from config.json. The case-insensitive dedup
 * pass guarantees an operator's `http-referer` (lowercase) cleanly
 * replaces our defaulted `HTTP-Referer` (cased) rather than producing
 * two header lines in the outgoing request.
 */
import { describe, it, expect } from 'vitest';
import { resolveExtraHeaders, type RunnerConfig } from '../../../src/cli/run-openai-agent';

const base: RunnerConfig = { endpoint: 'http://x', model: 'm' };

describe('resolveExtraHeaders', () => {
  it('returns empty map when no provider and no headers', () => {
    expect(resolveExtraHeaders(base)).toEqual({});
  });

  it('injects OpenRouter defaults when provider="openrouter"', () => {
    const out = resolveExtraHeaders({ ...base, provider: 'openrouter' });
    expect(out).toEqual({
      'HTTP-Referer': 'https://github.com/grandamenium/cortextos',
      'X-Title': 'cortextOS',
    });
  });

  it('does not inject defaults for other providers', () => {
    expect(resolveExtraHeaders({ ...base, provider: 'vllm' })).toEqual({});
    expect(resolveExtraHeaders({ ...base, provider: 'local-llamacpp' })).toEqual({});
  });

  it('passes operator headers through when provider is absent', () => {
    const out = resolveExtraHeaders({
      ...base,
      headers: { 'X-Custom': 'val', 'User-Agent': 'my-app' },
    });
    expect(out).toEqual({ 'X-Custom': 'val', 'User-Agent': 'my-app' });
  });

  it('operator headers override openrouter defaults (same casing)', () => {
    const out = resolveExtraHeaders({
      ...base,
      provider: 'openrouter',
      headers: { 'HTTP-Referer': 'https://my-app.example' },
    });
    expect(out['HTTP-Referer']).toBe('https://my-app.example');
    expect(out['X-Title']).toBe('cortextOS');
    // No leftover default with the same lowercased name.
    expect(Object.keys(out).filter(k => k.toLowerCase() === 'http-referer').length).toBe(1);
  });

  it('operator headers override openrouter defaults (different casing — case-insensitive dedup)', () => {
    const out = resolveExtraHeaders({
      ...base,
      provider: 'openrouter',
      headers: { 'http-referer': 'https://my-app.example' },
    });
    // Operator's lowercase wins; cased default disappears.
    expect(out['http-referer']).toBe('https://my-app.example');
    expect(out['HTTP-Referer']).toBeUndefined();
    expect(out['X-Title']).toBe('cortextOS');
    expect(Object.keys(out).filter(k => k.toLowerCase() === 'http-referer').length).toBe(1);
  });

  it('operator can override both OpenRouter defaults', () => {
    const out = resolveExtraHeaders({
      ...base,
      provider: 'openrouter',
      headers: { 'HTTP-Referer': 'https://x', 'X-Title': 'y' },
    });
    expect(out).toEqual({ 'HTTP-Referer': 'https://x', 'X-Title': 'y' });
  });

  it('handles empty operator headers map cleanly', () => {
    const out = resolveExtraHeaders({ ...base, provider: 'openrouter', headers: {} });
    expect(out).toEqual({
      'HTTP-Referer': 'https://github.com/grandamenium/cortextos',
      'X-Title': 'cortextOS',
    });
  });

  it('does not leak duplicates when operator overrides multiple headers with different casing', () => {
    const out = resolveExtraHeaders({
      ...base,
      provider: 'openrouter',
      headers: { 'x-title': 'lowercase-title' },
    });
    const lowercased = Object.keys(out).map(k => k.toLowerCase());
    const titleCount = lowercased.filter(k => k === 'x-title').length;
    expect(titleCount).toBe(1);
    expect(out['x-title']).toBe('lowercase-title');
    expect(out['X-Title']).toBeUndefined();
  });

  it('returns a fresh object each call (no shared state)', () => {
    const a = resolveExtraHeaders({ ...base, provider: 'openrouter' });
    const b = resolveExtraHeaders({ ...base, provider: 'openrouter' });
    expect(a).not.toBe(b);
    a['HTTP-Referer'] = 'mutated';
    expect(b['HTTP-Referer']).toBe('https://github.com/grandamenium/cortextos');
  });
});
