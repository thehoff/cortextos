import { describe, it, expect, vi } from 'vitest';

// auth.ts chains to NextAuth + better-sqlite3 (via ./db) at module load, neither of
// which we want to spin up for a pure-logic test. Stub those so the module imports
// cleanly, then exercise the REAL `resolveSecureCookies` exported from auth.ts — this
// binds the test to the actual source expression (no duplicated predicate to drift).
vi.mock('next-auth', () => ({
  default: () => ({ handlers: {}, auth: () => {}, signIn: () => {}, signOut: () => {} }),
}));
vi.mock('next-auth/providers/credentials', () => ({ default: () => ({}) }));
vi.mock('bcryptjs', () => ({ default: { compare: async () => false, hash: async () => '' } }));
vi.mock('../db', () => ({ db: { prepare: () => ({ get: () => undefined, run: () => {} }) } }));
vi.mock('../rate-limit', () => ({ checkRateLimit: () => ({ allowed: true }), resetRateLimit: () => {} }));

import { resolveSecureCookies, insecureCookieWarning } from '../auth';

// Guard for the #144 LAN variant: a production deployment on a trusted LAN served
// over plain HTTP (e.g. http://framework:1700) must be able to opt out of the Secure
// cookie flag via ALLOW_HTTP_COOKIES=true, otherwise browsers refuse to send the
// session cookie on non-localhost HTTP origins and login loops back to /login.
describe('resolveSecureCookies (ALLOW_HTTP_COOKIES)', () => {
  it('is Secure in production by default (no opt-out)', () => {
    expect(resolveSecureCookies({ NODE_ENV: 'production' })).toBe(true);
  });

  it('drops the Secure flag in production when ALLOW_HTTP_COOKIES=true', () => {
    expect(
      resolveSecureCookies({ NODE_ENV: 'production', ALLOW_HTTP_COOKIES: 'true' }),
    ).toBe(false);
  });

  it('keeps the Secure flag when ALLOW_HTTP_COOKIES has any other value', () => {
    expect(
      resolveSecureCookies({ NODE_ENV: 'production', ALLOW_HTTP_COOKIES: 'false' }),
    ).toBe(true);
    expect(
      resolveSecureCookies({ NODE_ENV: 'production', ALLOW_HTTP_COOKIES: '1' }),
    ).toBe(true);
    expect(
      resolveSecureCookies({ NODE_ENV: 'production', ALLOW_HTTP_COOKIES: '' }),
    ).toBe(true);
  });

  it('is never Secure outside production, regardless of opt-out flag', () => {
    expect(resolveSecureCookies({ NODE_ENV: 'development' })).toBe(false);
    expect(
      resolveSecureCookies({ NODE_ENV: 'development', ALLOW_HTTP_COOKIES: 'true' }),
    ).toBe(false);
    expect(resolveSecureCookies({ NODE_ENV: 'test' })).toBe(false);
    expect(resolveSecureCookies({})).toBe(false);
  });
});

describe('insecureCookieWarning (boot-time audit log)', () => {
  it('warns only when the Secure flag is actually disabled in production', () => {
    const msg = insecureCookieWarning({ NODE_ENV: 'production', ALLOW_HTTP_COOKIES: 'true' });
    expect(msg).toContain('ALLOW_HTTP_COOKIES=true');
    expect(msg).toContain('Secure flag DISABLED');
  });

  it('is silent in production when the flag is not opted in', () => {
    expect(insecureCookieWarning({ NODE_ENV: 'production' })).toBeNull();
    expect(
      insecureCookieWarning({ NODE_ENV: 'production', ALLOW_HTTP_COOKIES: 'false' }),
    ).toBeNull();
  });

  it('is silent outside production even when the flag is set', () => {
    expect(
      insecureCookieWarning({ NODE_ENV: 'development', ALLOW_HTTP_COOKIES: 'true' }),
    ).toBeNull();
    expect(insecureCookieWarning({})).toBeNull();
  });
});
