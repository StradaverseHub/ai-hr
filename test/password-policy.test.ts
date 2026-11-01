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
