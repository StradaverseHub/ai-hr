import type { EpfWorkingExplanation } from '@/core/statutory-explain';

const methodLabels = {
  entered_rate: 'epfEnteredRate',
  schedule_row: 'epfScheduleRow',
  schedule_formula: 'epfScheduleFormula',
  no_contribution: 'epfNoContribution',
} as const;

/** The on-screen card and the workbook use the same labels and the same stored figures. */
export function epfWorkingRows(
  working: EpfWorkingExplanation,
  t: (key: string) => string,
  money: (amount: number) => string,
  locale: string,
): { label: string; value: string }[] {
  const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 4 });
  const rows = [
    { label: t('epfActualWage'), value: money(working.actualWage) },
    { label: t('epfRoundingIncrement'), value: money(working.increment) },
    { label: t('epfRoundedWage'), value: money(working.roundedWage) },
    { label: t('epfEmployeeMethod'), value: t(methodLabels[working.employee.method]) },
    { label: t('epfEmployeeRate'), value: percent.format(working.employee.rate) },
    { label: t('epfCalculatedEmployee'), value: money(working.employee.amount) },
    { label: t('epfEmployerMethod'), value: t(methodLabels[working.employer.method]) },
  ];
  const employer = working.employer;
  if (employer.method === 'entered_rate' || employer.method === 'schedule_formula') {
    rows.push({ label: t('epfEmployerRate'), value: percent.format(employer.rate) });
  }
  if (employer.method === 'schedule_row' || employer.method === 'schedule_formula') {
    rows.push({ label: t('epfSchedulePart'), value: employer.schedulePart });
  }
  if (employer.method === 'schedule_row') {
    rows.push(
      { label: t('epfBandFrom'), value: money(employer.bandFrom) },
      { label: t('epfBandUpTo'), value: money(employer.bandUpTo) },
    );
  }
  if (working.scheduleEffectiveFrom) {
    rows.push({ label: t('epfScheduleEffective'), value: working.scheduleEffectiveFrom });
  }
  rows.push(
    { label: t('epfCalculatedEmployer'), value: money(employer.amount) },
    { label: t('epfEmployeeThisRun'), value: money(working.employeeThisRun) },
    { label: t('epfEmployerThisRun'), value: money(working.employerThisRun) },
    { label: t('epfFinalEmployee'), value: money(working.finalEmployee) },
    { label: t('epfFinalEmployer'), value: money(working.finalEmployer) },
    ...working.items.map((item) => ({ label: `${t('epfWageItem')} · ${item.label}`, value: money(item.amount) })),
  );
  return rows;
}
