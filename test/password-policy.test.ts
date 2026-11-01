import { describe, expect, it } from 'vitest';
import { DEFAULT_PASSWORD_POLICY, passwordExpired, validatePasswordPolicy } from '../lib/password-policy';
const at = (iso: string) => Date.parse(iso);
describe('password expiry policy', () => {
  it('validates bounded whole days and calendar months without coercion', () => {
    expect(validatePasswordPolicy({ enabled: true, interval: 3, unit: 'months' })).toEqual({ enabled: true, interval: 3, unit: 'months' });
    for (const interval of [0, -1, 1.5, 3651, '90', NaN, Infinity]) expect(() => validatePasswordPolicy({ enabled: true, interval, unit: 'days' })).toThrow('invalid');
    expect(() => validatePasswordPolicy({ enabled: true, interval: 121, unit: 'months' })).toThrow('invalid');
    expect(() => validatePasswordPolicy({ enabled: true, interval: 1, unit: 'years' })).toThrow('invalid');
  });
  it('leaves expiry disabled by default and treats missing or invalid legacy dates as expired only when enabled', () => {
    expect(passwordExpired(undefined, DEFAULT_PASSWORD_POLICY)).toBe(false);
    for (const changed of [undefined, NaN, 0, -1, Date.now() + 10000]) expect(passwordExpired(changed, { enabled: true, interval: 90, unit: 'days' })).toBe(true);
  });
  it('expires at the exact elapsed day boundary', () => {
    const changed = at('2026-11-01T16:30:00Z'), policy = { enabled: true, interval: 2, unit: 'days' } as const;
    expect(passwordExpired(changed, policy, at('2026-11-03T16:29:59.999Z'))).toBe(false);
    expect(passwordExpired(changed, policy, at('2026-11-03T16:30:00Z'))).toBe(true);
  });
  it.each([
    ['2026-01-30T16:30:00Z', '2026-02-27T16:30:00Z'], // 31 Jan MYT -> 28 Feb MYT
    ['2028-01-30T16:30:00Z', '2028-02-28T16:30:00Z'], // leap year
    ['2026-12-14T01:15:00Z', '2027-01-14T01:15:00Z'],
  ])('clamps MYT calendar months while preserving time: %s', (start, due) => {
    const policy = { enabled: true, interval: 1, unit: 'months' } as const;
    expect(passwordExpired(at(start), policy, at(due) - 1)).toBe(false);
    expect(passwordExpired(at(start), policy, at(due))).toBe(true);
  });
});

describe('password reuse history with real cryptography and encrypted storage', () => {
  it('refuses the original and nonadjacent passwords while isolating another subject', async () => {
    const { vi } = await import('vitest');
    vi.stubEnv('AUTH_PUBLIC_ORIGIN', 'https://hr.test'); vi.stubEnv('AUTH_SESSION_KEY', '4'.repeat(64));
    try {
      const { replacePassword } = await import('../lib/internal-auth/password-policy');
      const { passwordHash, passwordMatches } = await import('../lib/internal-auth/crypto');
      const records = new Map<string, string>();
      const tx = { unsafe: async (query: string, args: unknown[] = []) => {
        if (query.includes('internal_auth_read')) return records.has(String(args[0])) ? [{ sealed: records.get(String(args[0])) }] : [];
        if (query.includes('internal_auth_write')) { records.set(String(args[0]), String(args[2])); return []; }
        throw new Error('Unexpected query');
      } } as unknown as import('../lib/internal-auth/record-store').AuthSql;
      const original = 'Original private phrase 001!', second = 'Second private phrase 002!', third = 'Third private phrase 003!';
      const credential = { subject: 'subject-one', username: 'reader', email: 'reader@example.test', password: await passwordHash(original) } as import('../lib/internal-auth/credential').Credential;
      await replacePassword(tx, credential, second);
      await replacePassword(tx, credential, third);
      for (const previous of [original, second, third]) await expect(replacePassword(tx, credential, previous)).rejects.toMatchObject({ code: 'passwordPolicy' });
      expect(await passwordMatches(third, credential.password!)).toBe(true);
      const another = { ...credential, subject: 'subject-two', password: null };
      await replacePassword(tx, another, second);
      expect(await passwordMatches(second, another.password!)).toBe(true);
      const raw = JSON.stringify([...records]);
      for (const password of [original, second, third]) expect(raw).not.toContain(password);
    } finally { vi.unstubAllEnvs(); }
  }, 20_000);
});
