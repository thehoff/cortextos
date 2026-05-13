/**
 * PR4 Codex pass-1 PR4-001 (HIGH): some upstream debug-style backends echo
 * the inbound Authorization header in their 4xx response bodies. The runner
 * captures that body and embeds it in a thrown Error, which propagates to
 * stderr / PM2 logs / analytics events. With PR4's api_key_env, the key is
 * a real org-level secret and must not leak.
 *
 * redactSecrets() is the pure-function chokepoint applied between the
 * `.text()` capture and the `throw new Error(...)` call.
 */
import { describe, it, expect } from 'vitest';
import { redactSecrets } from '../../../src/openai-runner/loop';

describe('redactSecrets', () => {
  it('removes the literal api key from arbitrary text', () => {
    const text = 'Got 401 with token sk-or-v1-abc123def456 in body';
    expect(redactSecrets(text, 'sk-or-v1-abc123def456')).toBe(
      'Got 401 with token ***REDACTED*** in body',
    );
  });

  it('removes multiple occurrences of the key', () => {
    const text = 'auth=sk-or-secret-key url=https://x?key=sk-or-secret-key';
    const out = redactSecrets(text, 'sk-or-secret-key');
    expect(out).not.toContain('sk-or-secret-key');
    expect(out.match(/\*\*\*REDACTED\*\*\*/g)?.length).toBe(2);
  });

  it('removes Bearer-prefixed tokens regardless of the resolved key', () => {
    const text = 'Bearer sk-leaked-from-other-source rejected';
    const out = redactSecrets(text, undefined);
    expect(out).toBe('Bearer ***REDACTED*** rejected');
  });

  it('catches Bearer tokens even when the api key is also redacted', () => {
    const text = 'header was Bearer sk-explicit-key plus literal sk-explicit-key in body';
    const out = redactSecrets(text, 'sk-explicit-key');
    expect(out).not.toContain('sk-explicit-key');
    expect(out).toContain('Bearer ***REDACTED***');
  });

  it('handles case-insensitive Bearer prefix', () => {
    const text = 'bearer SOMETOKEN was rejected';
    const out = redactSecrets(text, undefined);
    expect(out).toBe('Bearer ***REDACTED*** was rejected');
  });

  it('does not redact when apiKey is undefined and no Bearer pattern is present', () => {
    const text = 'plain error message with no secret';
    expect(redactSecrets(text, undefined)).toBe(text);
  });

  it('redacts even short apiKey values (Codex pass-2 PR4-011)', () => {
    // Pre-PR4-011, sub-8-char keys were skipped on the theory that short
    // values were test placeholders. But a real 7-char key committed
    // by accident is still a secret, and the false-positive cost of
    // redacting a common short token in an error body is bounded.
    const text = 'The sk-test value was rejected';
    expect(redactSecrets(text, 'sk-test')).toBe('The ***REDACTED*** value was rejected');
  });

  it('preserves the rest of the response body for debugging', () => {
    const text = 'HTTP 401: bad auth, token=sk-leaked-key-12345, retry after 60s';
    const out = redactSecrets(text, 'sk-leaked-key-12345');
    expect(out).toContain('HTTP 401');
    expect(out).toContain('bad auth');
    expect(out).toContain('retry after 60s');
    expect(out).not.toContain('sk-leaked-key-12345');
  });

  it('handles empty input', () => {
    expect(redactSecrets('', 'sk-anything')).toBe('');
  });

  it('handles Bearer tokens with base64-shaped padding', () => {
    const text = 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig= got 403';
    const out = redactSecrets(text, undefined);
    expect(out).toBe('Bearer ***REDACTED*** got 403');
  });
});
