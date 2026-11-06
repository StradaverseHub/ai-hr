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
  const rows = 'category' in working ? topupRows(working, t, money, percent) : enteredRows(working, t, money, percent);
  if (working.scheduleEffectiveFrom) {
    rows.push({ label: t('epfScheduleEffective'), value: working.scheduleEffectiveFrom });
  }
  if (working.employeeEarlierRuns != null) {
    rows.push({ label: t('epfEmployeeEarlierRuns'), value: money(working.employeeEarlierRuns) });
  }
  if (working.employerEarlierRuns != null) {
    rows.push({ label: t('epfEmployerEarlierRuns'), value: money(working.employerEarlierRuns) });
  }
  rows.push(
    { label: t('epfEmployeeThisRun'), value: money(working.employeeThisRun) },
    { label: t('epfEmployerThisRun'), value: money(working.employerThisRun) },
    { label: t('epfFinalEmployee'), value: money(working.finalEmployee) },
    { label: t('epfFinalEmployer'), value: money(working.finalEmployer) },
    ...working.items.map((item) => ({ label: `${t('epfWageItem')} · ${item.label}`, value: money(item.amount) })),
  );
  return rows;
}

function enteredRows(
  working: Exclude<EpfWorkingExplanation, { category: string }>,
  t: (key: string) => string,
  money: (amount: number) => string,
  percent: Intl.NumberFormat,
) {
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
  rows.push({ label: t('epfCalculatedEmployer'), value: money(employer.amount) });
  return rows;
}

function topupRows(
  working: Extract<EpfWorkingExplanation, { category: string }>,
  t: (key: string) => string,
  money: (amount: number) => string,
  percent: Intl.NumberFormat,
) {
  const rows = [
    { label: t('epfCategory'), value: t('epfTopupCategory') },
    { label: t('epfActualWage'), value: money(working.actualWage) },
  ];
  if (working.schedulePart) rows.push({ label: t('epfSchedulePart'), value: working.schedulePart });

  for (const [side, labels] of [
    [working.employee, ['epfEmployeeMethod', 'epfEmployeeRate', 'epfCalculatedEmployee']],
    [working.employer, ['epfEmployerMethod', 'epfEmployerRate', 'epfCalculatedEmployer']],
  ] as const) {
    const [methodLabel, rateLabel, amountLabel] = labels;
    rows.push(
      { label: t(methodLabel), value: t(side.rate == null ? 'epfStatutoryAmount' : 'epfTopupFormula') },
      { label: t('epfSavedTopupRate'), value: side.savedRate == null ? '—' : percent.format(side.savedRate) },
      { label: t('epfStatutoryAmount'), value: money(side.statutoryAmount) },
    );
    if (side.rate != null && side.formulaAmount != null) {
      rows.push({ label: t(rateLabel), value: percent.format(side.rate) });
      const parts = side.parts ?? [{ wage: working.actualWage, amount: side.formulaAmount }];
      for (const part of parts) {
        rows.push({
          label: t('epfTopupFormula'),
          value: `${money(part.wage)} × ${percent.format(side.rate)} → ${money(part.amount)}`,
        });
      }
    }
    rows.push({ label: t(amountLabel), value: money(side.amount) });
  }
  return rows;
}
