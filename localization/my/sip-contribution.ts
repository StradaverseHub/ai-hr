/**
 * r412 (item e74af58c, step 2) — THE EIS (SIP) MONTHLY CONTRIBUTION SCHEDULE: the READ.
 *
 * IT IS THE BORANG 8A READ, RE-SHAPED — NOT A SECOND READ. `borang8AReport` already resolves the company,
 * the month, the selected payroll cycles, every payslip on them, and — since 18c1d92b — keeps the EIS
 * employer and employee legs apart per person, summed across the selected runs. This file calls it and
 * maps its rows through `sipRowsFrom` (lib/sip-contribution.ts). So:
 *   • NO EIS CALCULATION, anywhere: JUMLAH CARUMAN is the two legs the 8A read took off the payslips;
 *   • ONE cycle selection: `params.runSeqs` is honoured by the 8A read and nowhere else, which is the only
 *     reason the catalog entry may declare `runSelection`;
 *   • THE SAME REFUSALS: the readiness list is the 8A read's, unchanged — a missing identity card number
 *     (printed on this schedule too), a month whose runs were charged on different SOCSO/EIS wages, and a
 *     selection that holds no SOCSO/EIS at all (a bonus-only selection names every person with
 *     SOCSO_NOT_IN_SELECTION_REASON, whose words already say "SOCSO or EIS"). `hasBatch` and
 *     `selectionEmpty` pass through the same way.
 * The schedule's total is therefore, by construction, the sum of the 8A read's EIS legs for the same
 * selection — test/r412-sip-borang-8b.test.ts pins it against the payslips as well.
 *
 * ADR-0080 D1: `app/` reaches this only through core/reporting's `reportPreview`.
 */
import type { SessionContext } from '../../db/client';
import { contributionPeriodFor } from '../../lib/borang-8a';
import { sipContributionMonth, sipRowsFrom } from '../../lib/sip-contribution';
import { borang8AReport } from './borang-8a';
import type { ReportColumn, ReportParams, ReportResult, ReportRow } from './reports';

/** The schedule's columns, in the sample's own order and wording. BIL is the line number, drawn only. */
export const SIP_COLUMNS: ReportColumn[] = [
  { key: 'employerCode', label: 'Kod Majikan' },
  { key: 'ic', label: 'No. Kad Pengenalan' },
  { key: 'name', label: 'Nama Pekerja (Mengikut Kad Pengenalan)' },
  { key: 'contributionMonth', label: 'Bulan Carum' },
  { key: 'contribution', label: 'Jumlah Caruman (RM)', numeric: true },
];

const NOTE_LAYOUT =
  'Our own layout of an EIS (SIP) contribution schedule — the layout of the sample you sent, which is a report ' +
  'from a payroll system and not a PERKESO form. It has no declaration or signature section, and neither does this.';
const NOTE_FIGURES =
  'Jumlah Caruman is each person’s EIS employer and employee shares added, taken from the payroll run for the ' +
  'cycles chosen, never recalculated. The month is the payroll month itself, with no shift.';

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function sipContributionReport(ctx: SessionContext, params: ReportParams): Promise<ReportResult> {
  const periodKey = contributionPeriodFor(params.periodKey);
  const base = await borang8AReport(ctx, params);
  const h = base.meta.formHeader ?? {};
  const header: Record<string, string> = {
    employerCode: h.employerCode ?? '',
    employerName: h.employerName ?? '',
    contributionMonth: sipContributionMonth(periodKey),
    contributionPeriodKey: periodKey,
    payrollPeriodKey: params.periodKey,
  };
  const { rows, omitted } = sipRowsFrom(base.rows, {
    employerCode: header.employerCode,
    contributionMonth: header.contributionMonth,
  });
  const total = round2(rows.reduce((a, r) => a + r.contribution, 0));
  // The run's own EIS, as the 8A read summed it on its OWN path (per-person `eis`, not the legs) — the
  // reconciliation strip compares two routes to one number rather than printing one number twice.
  const runEis = base.meta.summary?.find((s) => String(s.label).startsWith('EIS'))?.value;
  const notes = [NOTE_LAYOUT, NOTE_FIGURES];
  if (omitted.length > 0) {
    notes.push(
      `Not on this schedule — paid on these payroll cycles with no EIS charged: ${omitted.map((o) => o.name).join(', ')}.`,
    );
  }
  return {
    columns: SIP_COLUMNS,
    rows: rows.map((r): ReportRow => ({ ...r })),
    totals: base.meta.hasBatch && !base.meta.selectionEmpty ? { contribution: total } : {},
    readiness: base.readiness,
    meta: {
      ...base.meta,
      formHeader: header,
      notes,
      summary:
        base.meta.hasBatch && !base.meta.selectionEmpty
          ? [
              { label: 'Jumlah Caruman (schedule)', value: total.toFixed(2) },
              ...(runEis != null ? [{ label: 'EIS in this run (EE+ER)', value: runEis }] : []),
            ]
          : [],
    },
  };
}
