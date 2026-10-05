import type { PcbExemptionDetail } from '@/core/pcb-exemptions';
import { formatMoney } from '@/lib/money';

/** One display projection for the screen and PDF; no calculation or current configuration reads. */
export function pcbExemptionTable(detail: PcbExemptionDetail, t: (key: string) => string) {
  const amount = (value: number | null) => value === null ? t('notRecordedShort') : `RM ${formatMoney(value, null)}`;
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
