import type { PayslipRunRow } from '@/core/payroll-view';
import { payslipPeriodOptionsFor } from '../individual-payslip/period-options';

export function resolveStatutoryPeriod(
  runs: readonly PayslipRunRow[],
  cycles: readonly { id: string; label: string }[],
  requested: { year?: number; month?: number; payrollCycleId?: string; payslipId?: string; cycle?: string },
) {
  const cycleIds = new Set(cycles.map((cycle) => cycle.id));
  const linked = (run: PayslipRunRow) => !!run.payrollCycleId && cycleIds.has(run.payrollCycleId);
  const ordered = runs.filter((run) => /^\d{4}-(0[1-9]|1[0-2])$/.test(run.payPeriod))
    .sort((a, b) => b.payPeriod.localeCompare(a.payPeriod) || b.runSeq - a.runSeq ||
      a.companyId.localeCompare(b.companyId) || a.payslipId.localeCompare(b.payslipId));
  const exact = requested.payslipId ? ordered.find((run) => run.payslipId === requested.payslipId &&
    (requested.year == null || Number(run.payPeriod.slice(0, 4)) === requested.year) &&
    (requested.month == null || Number(run.payPeriod.slice(5, 7)) === requested.month) &&
    (!requested.payrollCycleId || run.payrollCycleId === requested.payrollCycleId)) : undefined;
  const periods = ordered.map((run) => run.payPeriod);
  const years = payslipPeriodOptionsFor(true, periods, {}, 0).years;
  const year = exact ? Number(exact.payPeriod.slice(0, 4))
    : requested.year != null && years.includes(requested.year) ? requested.year : years[0];
  const months = payslipPeriodOptionsFor(true, periods, { year }, 0).months;
  const month = exact ? exact.payPeriod.slice(5, 7)
    : months.find((value) => Number(value) === requested.month) ?? months.at(-1);
  const inPeriod = ordered.filter((run) => run.payPeriod === `${year}-${month}`);
  const availableCycleIds = new Set(inPeriod.filter(linked).map((run) => run.payrollCycleId));
  const availableCycles = cycles.filter((cycle) => availableCycleIds.has(cycle.id));
  const preferred = requested.cycle ? inPeriod.find((run) => run.runType === requested.cycle && linked(run)) : undefined;
  const payrollCycleId = exact ? (linked(exact) ? exact.payrollCycleId ?? undefined : undefined)
    : availableCycles.find((cycle) => cycle.id === requested.payrollCycleId)?.id ??
      preferred?.payrollCycleId ?? inPeriod.find(linked)?.payrollCycleId ?? undefined;
  const matchingRuns = payrollCycleId ? inPeriod.filter((run) => run.payrollCycleId === payrollCycleId) : [];
  const selected = requested.payslipId ? exact : matchingRuns[0];

  return {
    year, month, years, months, payrollCycleId, availableCycles, matchingRuns, selected,
    unmatchedRuns: inPeriod.filter((run) => !linked(run)),
  };
}
