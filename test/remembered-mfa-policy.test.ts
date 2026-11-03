import { describe, expect, it } from 'vitest';
import { DEFAULT_REMEMBERED_MFA_POLICY, validateRememberedMfaPolicy } from '../lib/remembered-mfa-policy';
import { rememberedMfaCopy } from '../lib/remembered-mfa-copy';
describe('remembered MFA policy and vocabulary', () => {
  it('defaults to 30 days, supports every-sign-in and refuses unbounded or ambiguous policy', () => {
    expect(DEFAULT_REMEMBERED_MFA_POLICY).toEqual({ rememberDays: 30 });
    for (const rememberDays of [0, 1, 7, 30, 90]) expect(validateRememberedMfaPolicy({ rememberDays })).toEqual({ rememberDays });
    for (const value of [{ rememberDays: -1 }, { rememberDays: 91 }, { rememberDays: 1.5 }, { rememberDays: '30' }, { rememberDays: 30, bypass: true }]) expect(() => validateRememberedMfaPolicy(value)).toThrow('invalid');
  });
  it('provides complete nonempty copy in all six locales, with the expiry placeholder intact', () => {
    const en = rememberedMfaCopy('en');
    for (const locale of ['en', 'ms', 'zh', 'ta', 'th', 'vi']) {
      const copy = rememberedMfaCopy(locale); expect(Object.keys(copy).sort()).toEqual(Object.keys(en).sort());
      expect(Object.values(copy).every(value => value.trim())).toBe(true);
      expect(copy.rememberWeb).toContain('{days}'); expect(copy.rememberNative).toContain('{days}');
    }
  });
});
