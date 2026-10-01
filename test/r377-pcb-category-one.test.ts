import { describe, expect, it } from 'vitest';
import { pcbMonth } from '../localization/my/payroll';
import { childReliefFor, childReliefPrices } from '../localization/my/child-relief';
import { DEFAULT_MY_STATUTORY } from '../localization/my/statutory-tables';

// HASiL 2026 computerised MTD specification, pages 10–11: category 1 C=0;
// categories 2/3 retain qualifying children. Explicit amounts may not bypass that rule.
describe('r377 category one child eligibility', () => {
  const prices = childReliefPrices(DEFAULT_MY_STATUTORY.pcb.reliefs);
  const table = { under_18: { full: 1 }, disabled_study: { half: 1 } };
  it.each([undefined, 10000])('ignores declared relief %s for category one, including bonus', childReliefAmount => {
    const base = { monthlyWage: 14000, epfMonthly: 1540, month: 7, additional: 3000, epfOnAdditional: 330 };
    const zero = pcbMonth({ ...base, profile: { category: 1, children: 0 } });
    const claimed = pcbMonth({ ...base, profile: { category: 1, children: 5, childReliefAmount } });
    expect(claimed.total).toBe(zero.total);
    expect(claimed.additional).toBe(zero.additional);
    expect(claimed.snapshot.reliefs.children).toBe(0);
    expect(claimed.snapshot.trace?.childCount).toBe(0);
    expect(claimed.snapshot.P1).toBe(zero.snapshot.P1);
  });
  it.each([2, 3] as const)('preserves weighted claims for eligible category %s', category => {
    const figure = childReliefFor({ from: 'table', taxCategory: category, table, prices });
    expect(figure.units).toBe(5);
    expect(figure.amountRM).toBe(10000);
    const result = pcbMonth({ monthlyWage: 14000, epfMonthly: 1540, month: 7, profile: { category, childReliefAmount: figure.amountRM } });
    expect(result.snapshot.trace?.childCount).toBe(figure.units);
    expect(result.snapshot.reliefs.children).toBe(figure.amountRM);
  });
  it('shared screen pricing preserves declarations but zeroes category one contributions', () => {
    const figure = childReliefFor({ from: 'table', taxCategory: 1, table, prices });
    expect(figure.units).toBe(0);
    expect(figure.amountRM).toBe(0);
    expect(figure.rows.map(row => row.children)).toEqual([1, 1]);
    expect(figure.rows.every(row => row.units === 0 && row.amountRM === 0)).toBe(true);
    expect(childReliefFor({ from: 'headCount', taxCategory: 1, children: 5, perChild: 2000 }).units).toBe(0);
    expect(childReliefFor({ from: 'table', table, prices }).units).toBe(5);
  });
});
