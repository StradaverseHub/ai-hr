import type { HrdfWorkingExplanation } from '@/core/statutory-explain';

/**
 * Feedback c2ea9567 — the HRD Corp levy's itemised working, as rows. The on-screen table (Transaction View
 * › Statutory Explanation and the standalone Statutory Detail screen share one view) and the Excel export
 * both build from THIS function, so the screen and the file cannot list different lines.
 *
 * Every amount is read off the payslip's own `statutory.hrdfWorking` stamp; nothing is recomputed. The
 * rate is the stamped rate, and the calculation line is `wages × rate = calculated levy` — a product the
 * kernel really evaluated. When a person set the levy by hand the levy row says so and carries the
 * applied figure, while the calculation line keeps the figure the rate produced.
 *
 * STATIC KEYS ONLY. A computed `t()` key is invisible to the i18n coverage scan.
 */
export type HrdfWorkingRow = {
  description: string;
  /** The pay item code, shown beside its name; absent for basic, unpaid leave and totals. */
  code?: string;
  treatment: string;
  amount: string;
  /** Total / levy rows are emphasised on screen. */
  emphasis?: boolean;
};

type T = (key: string, values?: Record<string, string>) => string;

const STATUS_LABEL = {
  mandatory: 'hrdfStatusMandatory',
  optional: 'hrdfStatusOptional',
  not_registered: 'hrdfStatusNotRegistered',
} as const;

/** The rate as a percentage with no trailing zeros: 0.01 → "1%", 0.005 → "0.5%". */
export function hrdfRateLabel(rate: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 4 }).format(rate);
}

export function hrdfWorkingRows(
  working: HrdfWorkingExplanation,
  t: T,
  money: (amount: number) => string,
  locale: string,
): HrdfWorkingRow[] {
  const signed = (amount: number) => (amount > 0 ? `+${money(amount)}` : amount < 0 ? `−${money(-amount)}` : money(0));
  const rows: HrdfWorkingRow[] = [];
  for (const item of working.items) {
    switch (item.kind) {
      case 'basic':
        rows.push({ description: t('hrdfBasic'), treatment: t('hrdfBasicTreatment'), amount: money(item.amount) });
        break;
      case 'earning':
        rows.push({
          description: item.name || item.code || t('hrdfPayItem'),
          ...(item.code ? { code: item.code } : {}),
          treatment: t('hrdfEarningTreatment'),
          amount: signed(item.amount),
        });
        break;
      case 'allowance':
        rows.push({ description: t('hrdfAllowance'), treatment: t('hrdfEarningTreatment'), amount: signed(item.amount) });
        break;
      case 'unpaid':
        rows.push({ description: t('hrdfUnpaid'), treatment: t('hrdfDeductionTreatment'), amount: signed(item.amount) });
        break;
      case 'deduction':
        rows.push({
          description: item.name || item.code || t('hrdfPayItem'),
          ...(item.code ? { code: item.code } : {}),
          treatment: t('hrdfDeductionTreatment'),
          amount: signed(item.amount),
        });
        break;
      case 'floor':
        rows.push({ description: t('hrdfFloor'), treatment: t('hrdfFloorTreatment'), amount: signed(item.amount) });
        break;
    }
  }
  rows.push({ description: t('hrdfTotalWages'), treatment: '', amount: money(working.wages), emphasis: true });
  rows.push({
    description: t('hrdfRateRow'),
    // The company's registration decides first: an unregistered employer owes nothing for anybody, and
    // calling that "employee not subject" would send the reader to the wrong record.
    treatment: working.status === 'not_registered' || working.subject ? t(STATUS_LABEL[working.status]) : t('hrdfNotSubject'),
    amount: hrdfRateLabel(working.rate, locale),
  });
  rows.push({
    description: t('hrdfLevyRow'),
    treatment: working.levySetByHand ? t('hrdfLevySetByHand') : '',
    amount: money(working.levy),
    emphasis: true,
  });
  return rows;
}

/** "Calculation: RM3,000.00 × 1% = RM30.00" — the stamped wages, the stamped rate, the levy they produced. */
export function hrdfCalculationLine(
  working: HrdfWorkingExplanation,
  t: T,
  money: (amount: number) => string,
  locale: string,
): string {
  return t('hrdfCalculation', {
    wages: money(working.wages),
    rate: hrdfRateLabel(working.rate, locale),
    levy: money(working.calculatedLevy),
  });
}
