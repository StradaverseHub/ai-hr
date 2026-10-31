import type { PcbExemptionDetail } from '@/core/pcb-exemptions';
import { formatMoney, type CurrencyCode } from '@/lib/money';

/** One display projection for the screen and PDF; no calculation or current configuration reads.
 *  Amounts use the page's own currency formatter, so one page never mixes two money notations. */
export function pcbExemptionTable(detail: PcbExemptionDetail, t: (key: string) => string, currency: CurrencyCode | null) {
  const amount = (value: number | null) => value === null ? t('notRecordedShort') : formatMoney(value, currency);
  return {
    columns: ['exemptionType', 'exemptionAnnualLimit', 'exemptionAccumulated', 'exemptionThisMonth'].map(t),
    rows: detail.rows.map(row => ({
      label: [row.code, ...row.payItems, ...(row.reused ? [t('exemptionReused')] : [])].join(' · '),
      cells: [row.annualLimit === -1 ? t('exemptionUnlimited') : amount(row.annualLimit), amount(row.accumulated), amount(row.thisMonth)],
    })),
    note: t(detail.source === 'recorded' ? 'exemptionBasisNote' : 'exemptionIncompleteNote'),
    empty: t(detail.source === 'recorded' ? 'exemptionNone' : 'notRecordedShort'),
  };
}
