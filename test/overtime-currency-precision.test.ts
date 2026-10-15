import {describe, expect, it} from 'vitest';
import {currencyMinorScale} from '../lib/currencies';
describe('canonical currency precision for explicit Overtime money', () => {
  it('distinguishes whole, hundredth and thousandth currency units', () => {
    expect(currencyMinorScale('MYR')).toBe(2);
    expect(currencyMinorScale('JPY')).toBe(0);
    expect(currencyMinorScale('BHD')).toBe(3);
  });
  it('does not accept an arbitrary Intl three-letter code or normalize an unvalidated value', () => {
    for (const code of ['ZZZ', 'myr', ' MYR ', '', 'MYR;SELECT']) expect(() => currencyMinorScale(code)).toThrow();
  });
});
