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

  /**
   * PR4 (provider polish): config schema for hosted-provider polish.
   *
   *   - api_key is now type-checked (was implicitly typed before).
   *   - api_key_env names a process.env variable holding the key.
   *   - api_key + api_key_env are mutually exclusive at config time.
   *   - headers is an arbitrary {k: v} merged into LLM requests, but
   *     Content-Type and Authorization are reserved by the runner.
   *   - provider is an informational tag; some values (e.g. "openrouter")
   *     also trigger default headers at runtime.
   */
  describe('PR4 provider polish', () => {
    describe('api_key', () => {
      it('rejects api_key that is not a string', () => {
        expect(() => validateConfig({ endpoint: 'http://x', model: 'm', api_key: 42 })).toThrow(/api_key/);
        expect(() => validateConfig({ endpoint: 'http://x', model: 'm', api_key: null })).toThrow(/api_key/);
        expect(() => validateConfig({ endpoint: 'http://x', model: 'm', api_key: [] })).toThrow(/api_key/);
        expect(() => validateConfig({ endpoint: 'http://x', model: 'm', api_key: {} })).toThrow(/api_key/);
      });
      it('rejects empty api_key', () => {
        expect(() => validateConfig({ endpoint: 'http://x', model: 'm', api_key: '' })).toThrow(/api_key/);
      });
      it('rejects api_key longer than 512 chars', () => {
        expect(() => validateConfig({ endpoint: 'http://x', model: 'm', api_key: 'x'.repeat(513) })).toThrow(/api_key/);
      });
      it('accepts a sensibly-shaped api_key', () => {
        expect(() => validateConfig({ endpoint: 'http://x', model: 'm', api_key: 'sk-or-test-123' })).not.toThrow();
      });
    });

    describe('api_key_env', () => {
      it('accepts a POSIX env name', () => {
        const cfg = validateConfig({ endpoint: 'http://x', model: 'm', api_key_env: 'OPENROUTER_API_KEY' });
        expect(cfg.api_key_env).toBe('OPENROUTER_API_KEY');
      });
      it('rejects a lowercased env name', () => {
        expect(() => validateConfig({ endpoint: 'http://x', model: 'm', api_key_env: 'openrouter_api_key' })).toThrow(/api_key_env/);
      });
      it('rejects an env name starting with a digit', () => {
        expect(() => validateConfig({ endpoint: 'http://x', model: 'm', api_key_env: '4KEY' })).toThrow(/api_key_env/);
      });
      it('rejects an empty env name', () => {
        expect(() => validateConfig({ endpoint: 'http://x', model: 'm', api_key_env: '' })).toThrow(/api_key_env/);
      });
      it('rejects an env name longer than 64 chars', () => {
        expect(() => validateConfig({ endpoint: 'http://x', model: 'm', api_key_env: 'A'.repeat(65) })).toThrow(/api_key_env/);
      });
      it('rejects non-string api_key_env', () => {
        expect(() => validateConfig({ endpoint: 'http://x', model: 'm', api_key_env: 42 })).toThrow(/api_key_env/);
      });
      it('rejects setting both api_key and api_key_env', () => {
        expect(() => validateConfig({
          endpoint: 'http://x', model: 'm',
          api_key: 'sk-test', api_key_env: 'FOO_KEY',
        })).toThrow(/mutually exclusive/);
      });
    });

    describe('headers', () => {
      it('accepts a simple headers map', () => {
        const cfg = validateConfig({
          endpoint: 'http://x', model: 'm',
          headers: { 'HTTP-Referer': 'https://example', 'X-Title': 'app' },
        });
        expect(cfg.headers?.['HTTP-Referer']).toBe('https://example');
      });
      it('accepts an empty headers map', () => {
        expect(() => validateConfig({ endpoint: 'http://x', model: 'm', headers: {} })).not.toThrow();
      });
      it('rejects non-object headers', () => {
        expect(() => validateConfig({ endpoint: 'http://x', model: 'm', headers: 'oops' })).toThrow(/headers/);
        expect(() => validateConfig({ endpoint: 'http://x', model: 'm', headers: ['a'] })).toThrow(/headers/);
        expect(() => validateConfig({ endpoint: 'http://x', model: 'm', headers: null })).toThrow(/headers/);
      });
      it('rejects CR/LF/NUL in header values (CRLF injection guard)', () => {
        expect(() => validateConfig({
          endpoint: 'http://x', model: 'm',
          headers: { 'X-Test': 'ok\r\nInjected: x' },
        })).toThrow(/CR.*LF.*NUL|headers/);
        expect(() => validateConfig({
          endpoint: 'http://x', model: 'm',
          headers: { 'X-Test': 'ok\nInjected' },
        })).toThrow(/CR.*LF.*NUL|headers/);
        expect(() => validateConfig({
          endpoint: 'http://x', model: 'm',
          headers: { 'X-Test': 'ok\x00null' },
        })).toThrow(/CR.*LF.*NUL|headers/);
      });
      it('rejects bad header key shapes', () => {
        expect(() => validateConfig({ endpoint: 'http://x', model: 'm', headers: { 'X Bad': 'v' } })).toThrow(/headers/);
        expect(() => validateConfig({ endpoint: 'http://x', model: 'm', headers: { 'X-Bad\r': 'v' } })).toThrow(/headers/);
        expect(() => validateConfig({ endpoint: 'http://x', model: 'm', headers: { '': 'v' } })).toThrow(/headers/);
      });
      it('rejects reserved header names case-insensitively', () => {
        expect(() => validateConfig({
          endpoint: 'http://x', model: 'm',
          headers: { 'Authorization': 'Bearer leaked' },
        })).toThrow(/reserved/);
        expect(() => validateConfig({
          endpoint: 'http://x', model: 'm',
          headers: { 'authorization': 'Bearer leaked' },
        })).toThrow(/reserved/);
        expect(() => validateConfig({
          endpoint: 'http://x', model: 'm',
          headers: { 'content-type': 'text/plain' },
        })).toThrow(/reserved/);
        expect(() => validateConfig({
          endpoint: 'http://x', model: 'm',
          headers: { 'Content-Type': 'text/plain' },
        })).toThrow(/reserved/);
      });
      it('rejects header values longer than 512 chars', () => {
        expect(() => validateConfig({
          endpoint: 'http://x', model: 'm',
          headers: { 'X-Big': 'x'.repeat(513) },
        })).toThrow(/headers/);
      });
      it('rejects empty header values', () => {
        expect(() => validateConfig({
          endpoint: 'http://x', model: 'm',
          headers: { 'X-Empty': '' },
        })).toThrow(/headers/);
      });
      it('rejects non-string header values', () => {
        expect(() => validateConfig({
          endpoint: 'http://x', model: 'm',
          headers: { 'X-Test': 42 },
        })).toThrow(/headers/);
      });
    });

    describe('provider', () => {
      it('accepts kebab-lowercase provider tags', () => {
        expect(() => validateConfig({ endpoint: 'http://x', model: 'm', provider: 'openrouter' })).not.toThrow();
        expect(() => validateConfig({ endpoint: 'http://x', model: 'm', provider: 'local-llamacpp' })).not.toThrow();
        expect(() => validateConfig({ endpoint: 'http://x', model: 'm', provider: 'vllm' })).not.toThrow();
      });
      it('rejects uppercase provider', () => {
        expect(() => validateConfig({ endpoint: 'http://x', model: 'm', provider: 'OpenRouter' })).toThrow(/provider/);
      });
      it('rejects provider with space or underscore', () => {
        expect(() => validateConfig({ endpoint: 'http://x', model: 'm', provider: 'open router' })).toThrow(/provider/);
        expect(() => validateConfig({ endpoint: 'http://x', model: 'm', provider: 'together_ai' })).toThrow(/provider/);
      });
      it('rejects provider starting with a digit', () => {
        expect(() => validateConfig({ endpoint: 'http://x', model: 'm', provider: '4ai' })).toThrow(/provider/);
      });
      it('rejects empty provider', () => {
        expect(() => validateConfig({ endpoint: 'http://x', model: 'm', provider: '' })).toThrow(/provider/);
      });
      it('rejects provider longer than 32 chars', () => {
        expect(() => validateConfig({ endpoint: 'http://x', model: 'm', provider: 'a'.repeat(33) })).toThrow(/provider/);
      });
    });

    describe('full provider-polish config', () => {
      it('accepts the full OpenRouter-style example', () => {
        const cfg = validateConfig({
          endpoint: 'https://openrouter.ai/api',
          model: 'anthropic/claude-3.5-haiku',
          api_key_env: 'OPENROUTER_API_KEY',
          provider: 'openrouter',
          headers: {
            'HTTP-Referer': 'https://example.invalid',
            'X-Title': 'demo',
          },
        });
        expect(cfg.api_key_env).toBe('OPENROUTER_API_KEY');
        expect(cfg.provider).toBe('openrouter');
        expect(cfg.headers?.['HTTP-Referer']).toBe('https://example.invalid');
      });
    });
  });
});
