import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decryptRecord, encryptRecord, opaque, passwordHash, passwordMatches, validatePassword } from '../lib/internal-auth/crypto';
import { internalConfig, internalReady } from '../lib/internal-auth/config';
beforeEach(() => { vi.stubEnv('AUTH_PUBLIC_ORIGIN', 'https://hr.test'); vi.stubEnv('AUTH_SESSION_KEY', '1'.repeat(64)); });
afterEach(() => vi.unstubAllEnvs());
describe('embedded credential primitives', () => {
  it('hashes with independent salts and verifies without truncating or normalizing passwords', async () => {
    const password = 'A private long passphrase 992!';
    const one = await passwordHash(password), two = await passwordHash(password);
    expect(one).not.toBe(two); expect(one).not.toContain(password);
    expect(await passwordMatches(password, one)).toBe(true);
    expect(await passwordMatches(password.toLowerCase(), one)).toBe(false);
    expect(await passwordMatches(password + ' ', one)).toBe(false);
    expect(await passwordMatches(password, 'scrypt$1$8$3$malicious')).toBe(false);
  });
  it('rejects weak, username/email-bearing and oversized passwords', () => {
    for (const value of ['short', 'username-with-123456789', 'email@example.test-123456', 'x'.repeat(129)])
      expect(() => validatePassword(value, 'username', 'email@example.test')).toThrow();
    expect(() => validatePassword('Long enough private phrase 882')).not.toThrow();
  });
  it('authenticates encryption purpose, key, expiration and content', () => {
    const expires = Date.now() + 10000, sealed = encryptRecord({ secret: 'not-in-database' }, 'credential:one', expires);
    expect(sealed).not.toContain('not-in-database'); expect(decryptRecord(sealed, 'credential:one')).toEqual({ secret: 'not-in-database' });
    expect(() => decryptRecord(sealed, 'credential:two')).toThrow();
    expect(() => decryptRecord(sealed, 'credential:one', expires)).toThrow();
    expect(() => decryptRecord(sealed.slice(0, -8) + 'AAAAAAAA', 'credential:one')).toThrow();
    vi.stubEnv('AUTH_SESSION_KEY', '2'.repeat(64)); expect(() => decryptRecord(sealed, 'credential:one')).toThrow();
  });
  it('requires canonical HTTPS configuration and a deployment key', () => {
    expect(internalReady()).toBe(true); vi.stubEnv('AUTH_PUBLIC_ORIGIN', 'http://private.lan'); expect(internalReady()).toBe(false);
    vi.stubEnv('AUTH_PUBLIC_ORIGIN', 'https://hr.test/path'); expect(() => internalConfig()).toThrow();
    vi.stubEnv('AUTH_PUBLIC_ORIGIN', 'https://hr.test'); vi.stubEnv('AUTH_SESSION_KEY', 'short'); expect(internalReady()).toBe(false);
    expect(opaque()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
