/** appOrigin resolves the public origin from configuration only. Explicit env objects keep these
 * cases independent of .env.local and of the runner's own NODE_ENV. */
import { describe, expect, it } from 'vitest';
import { appOrigin, configuredPublicOrigin } from '../lib/real-auth';

const KEY = 'a'.repeat(64);
const WORKOS = 'https://workos.fixture.test/callback';

describe('appOrigin', () => {
  it('keeps the internal provider unchanged: its HTTPS origin, never the WorkOS fallback', () => {
    expect(appOrigin({ AUTH_PROVIDER: 'internal', AUTH_PUBLIC_ORIGIN: 'https://hr.fixture.test', AUTH_SESSION_KEY: KEY,
      NEXT_PUBLIC_WORKOS_REDIRECT_URI: WORKOS, NODE_ENV: 'production' })).toBe('https://hr.fixture.test');
    // Internal sign-in keeps its stricter rule even in development: no http, no fallback.
    expect(appOrigin({ AUTH_PROVIDER: 'internal', AUTH_PUBLIC_ORIGIN: 'http://localhost:3000', AUTH_SESSION_KEY: KEY,
      NEXT_PUBLIC_WORKOS_REDIRECT_URI: WORKOS, NODE_ENV: 'development' })).toBeUndefined();
    expect(appOrigin({ AUTH_PROVIDER: 'internal', AUTH_PUBLIC_ORIGIN: 'https://hr.fixture.test',
      NEXT_PUBLIC_WORKOS_REDIRECT_URI: WORKOS })).toBeUndefined();
  });

  it('uses a valid AUTH_PUBLIC_ORIGIN when no provider is selected, ahead of the WorkOS redirect', () => {
    expect(appOrigin({ AUTH_PUBLIC_ORIGIN: 'https://hr.fixture.test', NODE_ENV: 'production' })).toBe('https://hr.fixture.test');
    expect(appOrigin({ AUTH_PUBLIC_ORIGIN: 'https://hr.fixture.test', NEXT_PUBLIC_WORKOS_REDIRECT_URI: WORKOS,
      NODE_ENV: 'production' })).toBe('https://hr.fixture.test');
    expect(appOrigin({ AUTH_PUBLIC_ORIGIN: 'https://hr.fixture.test:8443', NODE_ENV: 'production' })).toBe('https://hr.fixture.test:8443');
  });

  it.each(['development', 'test', undefined])('accepts http localhost and 127.0.0.1 outside production (NODE_ENV=%s)', nodeEnv => {
    expect(appOrigin({ AUTH_PUBLIC_ORIGIN: 'http://localhost:3000', NODE_ENV: nodeEnv })).toBe('http://localhost:3000');
    expect(appOrigin({ AUTH_PUBLIC_ORIGIN: 'http://127.0.0.1:3111', NODE_ENV: nodeEnv })).toBe('http://127.0.0.1:3111');
  });

  it('refuses http localhost in a production build and never falls back to WorkOS for it', () => {
    for (const origin of ['http://localhost:3000', 'http://127.0.0.1:3000']) {
      expect(appOrigin({ AUTH_PUBLIC_ORIGIN: origin, NODE_ENV: 'production' })).toBeUndefined();
      expect(appOrigin({ AUTH_PUBLIC_ORIGIN: origin, NODE_ENV: 'production', NEXT_PUBLIC_WORKOS_REDIRECT_URI: WORKOS })).toBeUndefined();
    }
  });

  it.each([
    'not a URL', 'hr.fixture.test', 'ftp://hr.fixture.test', 'javascript:alert(1)', 'file:///etc/passwd',
    'http://hr.fixture.test', 'http://localhost.fixture.test:3000', 'http://[::1]:3000', 'http://10.0.0.5:3000',
    'https://hr.fixture.test/app', 'https://hr.fixture.test/?next=1', 'https://hr.fixture.test/#top',
    'https://user@hr.fixture.test', 'https://user:secret@hr.fixture.test', 'http://user:secret@localhost:3000',
    'http://localhost:3000/path',
  ])('refuses malformed AUTH_PUBLIC_ORIGIN %s, without falling back to WorkOS', value => {
    for (const NODE_ENV of ['development', 'production']) {
      expect(configuredPublicOrigin({ AUTH_PUBLIC_ORIGIN: value, NODE_ENV })).toBeUndefined();
      expect(appOrigin({ AUTH_PUBLIC_ORIGIN: value, NODE_ENV, NEXT_PUBLIC_WORKOS_REDIRECT_URI: WORKOS })).toBeUndefined();
    }
  });

  it('keeps the WorkOS redirect URI as the last fallback when AUTH_PUBLIC_ORIGIN is absent or empty', () => {
    expect(appOrigin({ NEXT_PUBLIC_WORKOS_REDIRECT_URI: WORKOS, NODE_ENV: 'production' })).toBe('https://workos.fixture.test');
    expect(appOrigin({ AUTH_PUBLIC_ORIGIN: '', NEXT_PUBLIC_WORKOS_REDIRECT_URI: WORKOS })).toBe('https://workos.fixture.test');
    expect(appOrigin({ NODE_ENV: 'production' })).toBeUndefined();
    expect(appOrigin({})).toBeUndefined();
  });

  it('reads configuration only: the result is the same whatever a request might claim', () => {
    const env = { AUTH_PUBLIC_ORIGIN: 'https://hr.fixture.test', NODE_ENV: 'production', HOST: 'attacker.fixture.test',
      HTTP_X_FORWARDED_HOST: 'attacker.fixture.test' };
    expect(appOrigin(env)).toBe('https://hr.fixture.test');
  });
});
