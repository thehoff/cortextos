/**
 * PR2 (openai-compatible runtime): runner config.json validation contract.
 *
 * The runner reads config.json from CTX_AGENT_DIR at boot and exits non-zero
 * if it can't make sense of the file. This test pins what "make sense" means:
 *
 *   - endpoint must be a non-empty http(s) URL string
 *   - model must be a non-empty string
 *   - max_tokens / temperature / heartbeat_interval_sec / request_timeout_sec
 *     are optional, but when present must be sensible numbers
 *   - any other field is allowed and ignored (forward-compat — operators may
 *     add custom config keys)
 *
 * Catching these at boot beats failing per-message with a cryptic LLM HTTP
 * error mid-conversation. Errors propagate as exceptions; the runner's main()
 * converts them to process.exit(1) with the message on stderr.
 */
import { describe, it, expect } from 'vitest';
import { validateConfig } from '../../../src/cli/run-openai-agent';

describe('runner config validation', () => {
  describe('rejects invalid configs', () => {
    it('throws when config is not an object', () => {
      expect(() => validateConfig(null)).toThrow(/must be a JSON object/);
      expect(() => validateConfig('string')).toThrow(/must be a JSON object/);
      expect(() => validateConfig(42)).toThrow(/must be a JSON object/);
    });

    it('throws when endpoint is missing', () => {
      expect(() => validateConfig({ model: 'gpt-3.5' })).toThrow(/endpoint/);
    });

    it('throws when endpoint is not a string', () => {
      expect(() => validateConfig({ endpoint: 123, model: 'm' })).toThrow(/endpoint/);
    });

    it('throws when endpoint does not start with http(s)://', () => {
      expect(() => validateConfig({ endpoint: 'localhost:8080', model: 'm' })).toThrow(/http/);
      expect(() => validateConfig({ endpoint: 'ftp://x', model: 'm' })).toThrow(/http/);
    });

    it('throws when model is missing or empty', () => {
      expect(() => validateConfig({ endpoint: 'http://x' })).toThrow(/model/);
      expect(() => validateConfig({ endpoint: 'http://x', model: '' })).toThrow(/model/);
    });

    it('throws when max_tokens is out of range', () => {
      expect(() => validateConfig({ endpoint: 'http://x', model: 'm', max_tokens: 0 })).toThrow(/max_tokens/);
      expect(() => validateConfig({ endpoint: 'http://x', model: 'm', max_tokens: 100001 })).toThrow(/max_tokens/);
      expect(() => validateConfig({ endpoint: 'http://x', model: 'm', max_tokens: 'lots' })).toThrow(/max_tokens/);
    });

    it('throws when temperature is out of [0, 2]', () => {
      expect(() => validateConfig({ endpoint: 'http://x', model: 'm', temperature: -0.1 })).toThrow(/temperature/);
      expect(() => validateConfig({ endpoint: 'http://x', model: 'm', temperature: 2.1 })).toThrow(/temperature/);
      expect(() => validateConfig({ endpoint: 'http://x', model: 'm', temperature: 'hot' })).toThrow(/temperature/);
    });

    it('throws when heartbeat_interval_sec is below 5', () => {
      // Below 5s is too chatty for the bus + dashboard. The runner doesn't
      // need sub-5s precision — heartbeat is liveness, not telemetry.
      expect(() => validateConfig({ endpoint: 'http://x', model: 'm', heartbeat_interval_sec: 4 })).toThrow(/heartbeat_interval_sec/);
    });

    it('throws when request_timeout_sec is non-positive', () => {
      expect(() => validateConfig({ endpoint: 'http://x', model: 'm', request_timeout_sec: 0 })).toThrow(/request_timeout_sec/);
      expect(() => validateConfig({ endpoint: 'http://x', model: 'm', request_timeout_sec: -10 })).toThrow(/request_timeout_sec/);
    });
  });

  describe('accepts valid configs', () => {
    it('accepts minimal config (endpoint + model only)', () => {
      const cfg = validateConfig({ endpoint: 'http://localhost:8080', model: 'lfm2-8b' });
      expect(cfg.endpoint).toBe('http://localhost:8080');
      expect(cfg.model).toBe('lfm2-8b');
    });

    it('accepts https endpoints', () => {
      expect(() => validateConfig({ endpoint: 'https://api.example.com', model: 'm' })).not.toThrow();
    });

    it('accepts all optional fields at sensible values', () => {
      const cfg = validateConfig({
        endpoint: 'http://x',
        model: 'm',
        api_key: 'sk-test',
        max_tokens: 2000,
        temperature: 0.2,
        heartbeat_interval_sec: 60,
        request_timeout_sec: 120,
      });
      expect(cfg.api_key).toBe('sk-test');
      expect(cfg.max_tokens).toBe(2000);
      expect(cfg.temperature).toBe(0.2);
      expect(cfg.heartbeat_interval_sec).toBe(60);
      expect(cfg.request_timeout_sec).toBe(120);
    });

    it('ignores extra fields the runner doesn\'t recognize (forward-compat)', () => {
      const cfg = validateConfig({
        endpoint: 'http://x',
        model: 'm',
        custom_thing: { nested: true },
        future_field: 42,
      } as any);
      expect(cfg.endpoint).toBe('http://x');
      expect(cfg.model).toBe('m');
    });

    it('accepts temperature = 0 (greedy decoding)', () => {
      expect(() => validateConfig({ endpoint: 'http://x', model: 'm', temperature: 0 })).not.toThrow();
    });

    it('accepts temperature = 2 (boundary)', () => {
      expect(() => validateConfig({ endpoint: 'http://x', model: 'm', temperature: 2 })).not.toThrow();
    });
  });
});
