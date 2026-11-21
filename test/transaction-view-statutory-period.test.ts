import { describe, expect, it } from 'vitest';
import { resolveStatutoryPeriod } from '../app/payroll/transaction-view/statutory-period';
import type { PayslipRunRow } from '../core/payroll-view';

const cycles = [
  { id: 'monthly', label: 'Monthly' },
  { id: 'older', label: 'Older Monthly' },
  { id: 'unused', label: 'Unused' },
];
const runs: PayslipRunRow[] = [
  { payslipId: 'first', companyId: 'company', payPeriod: '2026-07', payrollCycleId: 'monthly', runSeq: 1, runType: 'regular' },
  { payslipId: 'latest', companyId: 'company', payPeriod: '2026-07', payrollCycleId: 'monthly', runSeq: 3, runType: 'regular' },
  { payslipId: 'legacy', companyId: 'company', payPeriod: '2026-07', payrollCycleId: null, runSeq: 2, runType: 'regular' },
  { payslipId: 'old', companyId: 'company', payPeriod: '2025-03', payrollCycleId: 'older', runSeq: 1, runType: 'regular' },
];

describe('Transaction View statutory period', () => {
  it('shows configured cycle names for runs in the selected period and defaults to the latest matching run', () => {
    const selection = resolveStatutoryPeriod(runs, cycles, {});
    expect(selection.years).toEqual([2026, 2025]);
    expect(selection.months).toEqual(['07']);
    expect(selection.availableCycles).toEqual([cycles[0]]);
    expect(selection.selected?.payslipId).toBe('latest');
    expect(selection.matchingRuns.map((run) => run.payslipId)).toEqual(['latest', 'first']);
    expect(selection.unmatchedRuns.map((run) => run.payslipId)).toEqual(['legacy']);
  });

  it('drops a stale month or cycle after the year changes', () => {
    const selection = resolveStatutoryPeriod(runs, cycles, { year: 2025, month: 7, payrollCycleId: 'monthly' });
    expect(selection.months).toEqual(['03']);
    expect(selection.availableCycles).toEqual([cycles[1]]);
    expect(selection.selected?.payslipId).toBe('old');
  });

  it('honors exact run links only within the selected scope and period', () => {
    expect(resolveStatutoryPeriod(runs, cycles, { payslipId: 'first', year: 2026 }).selected?.payslipId).toBe('first');
    expect(resolveStatutoryPeriod(runs, cycles, { payslipId: 'old', year: 2026 }).selected).toBeUndefined();
    expect(resolveStatutoryPeriod(runs, cycles, { payslipId: 'other-company' }).selected).toBeUndefined();
    expect(resolveStatutoryPeriod([], cycles, {}).years).toEqual([]);
  });
});
