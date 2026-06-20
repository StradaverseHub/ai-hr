/**
 * #73 (P-73c) — BNM bank-code routing for interbank bulk-payment files. The four Chin Hin banks must
 * resolve to their verified BNM codes; everything unmapped must HARD-FAIL (money routing — refuse, never
 * guess). Codes per the IBG Autopay spec's BNM table.
 */
import { describe, expect, it } from 'vitest';
import { bnmCodeForBankName, tryBnmCodeForBankName, UnknownBankError } from '../localization/my/bank-files/bnm-codes';

describe('BNM bank codes (#73)', () => {
  it('resolves the four Chin Hin banks + common name variants', () => {
    expect(bnmCodeForBankName('Maybank')).toBe('27');
    expect(bnmCodeForBankName('Malayan Banking Berhad')).toBe('27');
    expect(bnmCodeForBankName('Maybank Islamic')).toBe('27');
    expect(bnmCodeForBankName('CIMB')).toBe('35');
    expect(bnmCodeForBankName('CIMB Bank Berhad')).toBe('35');
    expect(bnmCodeForBankName('Public Bank')).toBe('33');
    expect(bnmCodeForBankName('Public Bank Berhad')).toBe('33');
    expect(bnmCodeForBankName('RHB')).toBe('18');
    expect(bnmCodeForBankName('RHB Bank (M)')).toBe('18');
  });

  it('hard-fails on an unmapped or empty bank name rather than mis-route', () => {
    expect(() => bnmCodeForBankName('Some Fintech Wallet')).toThrow(UnknownBankError);
    expect(() => bnmCodeForBankName('')).toThrow(UnknownBankError);
    expect(() => bnmCodeForBankName(null)).toThrow(/cannot be routed/i);
    // "Public Investment Bank" (a different entity) must NOT collapse to Public Bank.
    expect(() => bnmCodeForBankName('Public Investment Bank')).toThrow(UnknownBankError);
  });

  it('tryBnmCodeForBankName probes without throwing (for batch readiness lists)', () => {
    expect(tryBnmCodeForBankName('CIMB')).toBe('35');
    expect(tryBnmCodeForBankName('Unknown Co-op')).toBeNull();
  });
});
