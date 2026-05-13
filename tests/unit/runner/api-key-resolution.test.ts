/**
 * PR4 (provider polish): API-key resolution precedence.
 *
 *   api_key_env (process.env)  >  api_key  >  process.env.OPENAI_API_KEY
 *
 * The api_key_env path is the only one that can throw at boot (when the
 * named env var is unset or empty). All other branches are total functions
 * and fall through to undefined when nothing is configured.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveApiKey, type RunnerConfig } from '../../../src/cli/run-openai-agent';

const base: RunnerConfig = { endpoint: 'http://x', model: 'm' };

describe('resolveApiKey', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Strip any inherited keys so each test runs against a known env baseline.
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.MY_KEY;
  });

  afterEach(() => {
    // Restore — vitest sometimes shares processes between test files.
    for (const k of Object.keys(process.env)) {
      if (!(k in originalEnv)) delete process.env[k];
    }
    Object.assign(process.env, originalEnv);
  });

  it('returns process.env value when api_key_env is set and present', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-abc';
    const v = resolveApiKey({ ...base, api_key_env: 'OPENROUTER_API_KEY' });
    expect(v).toBe('sk-or-abc');
  });

  it('throws when api_key_env names an unset variable', () => {
    expect(() => resolveApiKey({ ...base, api_key_env: 'OPENROUTER_API_KEY' }))
      .toThrow(/OPENROUTER_API_KEY.*unset or empty/);
  });

  it('throws when api_key_env names a variable set to the empty string', () => {
    process.env.OPENROUTER_API_KEY = '';
    expect(() => resolveApiKey({ ...base, api_key_env: 'OPENROUTER_API_KEY' }))
      .toThrow(/unset or empty/);
  });

  it('error message names the missing env var verbatim', () => {
    try {
      resolveApiKey({ ...base, api_key_env: 'MY_KEY' });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('MY_KEY');
    }
  });

  it('returns api_key when only that is set', () => {
    const v = resolveApiKey({ ...base, api_key: 'sk-literal' });
    expect(v).toBe('sk-literal');
  });

  it('falls back to OPENAI_API_KEY when nothing else is set', () => {
    process.env.OPENAI_API_KEY = 'sk-fallback';
    const v = resolveApiKey(base);
    expect(v).toBe('sk-fallback');
  });

  it('returns undefined when nothing is configured', () => {
    expect(resolveApiKey(base)).toBeUndefined();
  });

  it('api_key_env wins over api_key when both are somehow set (should be blocked by validateConfig, but resolver is defensive)', () => {
    // validateConfig rejects this combination, so it cannot reach resolveApiKey
    // via the normal boot path. But the resolver is a pure function; pin the
    // tie-breaker so future refactors don't silently change precedence.
    process.env.MY_KEY = 'sk-from-env';
    const v = resolveApiKey({ ...base, api_key: 'sk-literal', api_key_env: 'MY_KEY' });
    expect(v).toBe('sk-from-env');
  });

  it('does NOT fall back to OPENAI_API_KEY when api_key is explicitly set', () => {
    process.env.OPENAI_API_KEY = 'sk-fallback';
    const v = resolveApiKey({ ...base, api_key: 'sk-explicit' });
    expect(v).toBe('sk-explicit');
  });
});
