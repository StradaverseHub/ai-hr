import { describe, expect, it } from 'vitest';
import { sumPayslipEmployerPeriodTotals } from '../core/payroll-view';
const row = (payPeriod: string, epfEmployer: unknown, overrides = {}) => ({ payPeriod,
  statutory: {epfEmployer, socsoEmployer: '1.25', eisEmployer: 0.5, hrdf: 2, ...overrides} });
describe('saved employer period reporting', () => {
  it('sums every eligible same-month run, retains existing full-year scope and signed adjustments', () => {
    const result = sumPayslipEmployerPeriodTotals([row('2026-05', '100.10'), row('2026-05', '-0.10'),
      row('2026-06', 40), row('2025-05', 900)], '2026-05');
    expect(result.mtd).toEqual({epf:100, socso:2.5, eis:1, hrdf:4});
    expect(result.ytd).toEqual({epf:140, socso:3.75, eis:1.5, hrdf:6});
  });
  it('reports unknown per field without treating missing, malformed or sub-cent stamps as zero', () => {
    for (const missing of [undefined, null, '', 'abc', '0.004', 0.004, Infinity, {}]) {
      const result = sumPayslipEmployerPeriodTotals([row('2026-05', missing)], '2026-05');
      expect(result.mtd.epf).toBeNull(); expect(result.ytd.epf).toBeNull();
      expect(result.mtd.socso).toBe(1.25);
    }
    expect(sumPayslipEmployerPeriodTotals([], '2026-05').mtd.epf).toBeNull();
    expect(sumPayslipEmployerPeriodTotals([row('2026-05', 0)], '2026-13').ytd.epf).toBeNull();
  });
  it('preserves explicit zero and does not reclassify employee shares funded by the employer', () => {
    const result = sumPayslipEmployerPeriodTotals([row('2026-05', 0, {
      epfEmployee:999, employerBorne:{epf:999, tax:888}, pcb:888,
    })], '2026-05');
    expect(result.mtd.epf).toBe(0);
    expect(result.mtd).not.toHaveProperty('pcb');
  });
});
