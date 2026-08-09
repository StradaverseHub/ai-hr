import type { ProcessedPayslipViewRow } from '@/core/payroll-view';
import type { ColAlign, ReportData } from '@/lib/report-export';
import { deriveHistoryBreakdown } from './history-breakdown';

/**
 * Feedback 0fcb2557 — "Export to Excel" on Transaction View › History.
 *
 * ONE WIDE SHEET, ON PURPOSE. The reporter asked for a two-sheet workbook (summary on one tab, the
 * line-by-line breakdown on the other) and the approved plan declines it in as many words: a SINGLE table
 * is what Excel's own sort, filter and pivot tools act on, whereas two sheets leave the reader matching
 * rows up by Employee ID and period by hand. So every payslip is one row, and the per-item detail that
 * lives inside an expanded row on screen becomes COLUMNS beside it.
 *
 * NO GRAND-TOTAL ROW. A totals row sitting inside the data is precisely what breaks Excel's sorting and
 * filtering — sort the sheet and the total lands in the middle of it. The columns are numeric, so a
 * finance user totals any of them in one click; that is the substitute, and it is a better one.
 *
 * A REGROUP, NEVER A RECOMPUTATION. Every money figure comes out of `deriveHistoryBreakdown` — the same
 * derivation the screen's expanded panel runs, i.e. what the payslip STORED. The file and the panel
 * therefore cannot disagree, which is the whole point of an export used for reconciliation.
 *
 * THE EMPLOYEE-SHARE TRAP. The EPF / SOCSO / SKBBK / EIS / PCB columns are
 * `employerBorne.employee.*` — what actually came off take-home — exactly as history-table.tsx prints in
 * both the summary row and the expanded panel. They are NOT the raw statutory blob and NOT what the
 * payroll register reports (`listPayrollRegisterAcross` deliberately reports the FULL computed share, so
 * when an "employer bears" flag is set this file's EPF and the per-run Transaction Detail file's
 * "EPF (Employee)" legitimately differ). That is why these headers deliberately do NOT reuse the
 * register's "(Employee)" wording: two columns that mean different things must not read the same.
 *
 * PURE. No React, no i18n, no DB — captions arrive pre-translated from the route, so the whole column
 * layout is unit-testable (test/history-export.test.ts) the way history-pivot.ts is. Headers stay
 * ENGLISH and come from the constant below (ADR-0047 §9, the same posture as the batch and register
 * exports).
 */

const num = (v: unknown) => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};

/**
 * A money cell, UNFORMATTED. `toXlsxReport` marks a cell `x:num` only when it parses as a bare number
 * (`/^-?\d+(\.\d+)?$/`), so "RM 5,600.00" would land as text an operator cannot sum — which would defeat
 * the one thing this file exists for. 5600.00, not "RM 5,600.00".
 */
const money = (v: unknown): string => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x.toFixed(2) : '';
};

/** The fixed block, in file order. Frozen columns first — see `HISTORY_EXPORT_FREEZE`. */
const FIXED_COLUMNS: { label: string; align: ColAlign }[] = [
  // ── The frozen block: who and when. Four columns, matching the approved mockup's "the first four
  //    columns stay put" — Excel keeps them on screen while the reader scrolls across the money.
  { label: 'Payroll Period', align: 'left' },
  { label: 'Payroll Cycle', align: 'left' },
  { label: 'Employee ID', align: 'left' },
  { label: 'Employee Name', align: 'left' },
  // Run No. sits immediately AFTER the frozen block rather than inside it (the plan's column list and its
  // `freeze: 4` disagreed; the mockup settles it — the four sticky columns it draws are period, cycle,
  // employee id, name). It has to be somewhere: ADR-0024 Wave 2C lets one (company, month) hold several
  // runs of the same type, and without it two such rows are indistinguishable.
  { label: 'Run No.', align: 'right' },
  { label: 'Company', align: 'left' },
  { label: 'Status', align: 'left' },
  // ── Summary + employee-borne deductions. SKBBK, CP38 and Zakat are carried even though they are nil on
  //    most runs, so the deduction columns visibly reconcile against Total Deductions.
  { label: 'Gross', align: 'right' },
  { label: 'EPF', align: 'right' },
  { label: 'SOCSO', align: 'right' },
  { label: 'SKBBK', align: 'right' },
  { label: 'EIS', align: 'right' },
  { label: 'PCB', align: 'right' },
  { label: 'CP38', align: 'right' },
  { label: 'Zakat', align: 'right' },
  { label: 'Total Deductions', align: 'right' },
  { label: 'Nett Wage', align: 'right' },
  // ── The earnings lines from the expanded panel, mirrored line for line.
  { label: 'Basic Salary', align: 'right' },
  { label: 'Allowances', align: 'right' },
  // f3148da1 — the OT excess redirected to a pay item. It is folded inside the stored allowance column, so
  // `Allowances` above has it taken back out and it stands on its own; together they still make Gross.
  { label: 'OT Converted From Allowance', align: 'right' },
  { label: 'Overtime', align: 'right' },
  { label: 'Bonus', align: 'right' },
  { label: 'Claim', align: 'right' },
  // ── Employer side. "Total Employer Contributions" is `employerContributions.total` (EPF + SOCSO + EIS +
  //    HRDF) — the figure the screen prints. It is NOT `payslip.employerCost`, a different stored number
  //    that includes wages, so it must not be labelled "Total Employer Cost" like the register's column.
  { label: 'Employer EPF', align: 'right' },
  { label: 'Employer SOCSO', align: 'right' },
  { label: 'Employer EIS', align: 'right' },
  { label: 'HRDF', align: 'right' },
  { label: 'Total Employer Contributions', align: 'right' },
];

/** English headers of the fixed block, in order — exported so the test can pin them. */
export const HISTORY_EXPORT_FIXED_COLUMNS: readonly string[] = FIXED_COLUMNS.map((c) => c.label);

/** Leading columns kept as Excel's frozen pane: period, cycle, employee id, employee name. */
export const HISTORY_EXPORT_FREEZE = 4;

/**
 * Recorded items get their own headed block so a reader cannot mistake one for an earning.
 *
 * `recordLines` has been a MIXED population since f1564110 phase 3: non-payable benefits in kind AND named
 * provenance for consumed one-off transactions, the deductions among them carrying a NEGATIVE sign. Merging
 * them into the named-allowance block would put negative deductions and no-cash-impact items into the same
 * columns as allowances — and the two sets can collide on code, so one column would silently hold both.
 */
export const RECORDED_ITEM_PREFIX = 'Recorded item: ';

export type HistoryExportInput = {
  /** Already scope-guarded rows from `listProcessedPayslipsAcross`. This module authorises nothing. */
  rows: ProcessedPayslipViewRow[];
  /** efece4ce — companies whose HRD Corp levy is registered. Anything else gets a BLANK HRDF cell rather
   *  than a 0, mirroring the screen's "Not registered": a 0 there is a policy statement, not a figure. */
  hrdfRegisteredCompanyIds?: string[];
  /** Pre-translated run-type captions keyed by run type (a computed t() key stays out of this module). */
  cycleLabels?: Record<string, string>;
  /** Pre-translated batch-status captions keyed by status. */
  statusLabels?: Record<string, string>;
  /** Sheet name + heading. Excel truncates the sheet name at 31 characters. */
  title: string;
  /** ASCII-safe filename stem; the serializer appends the extension. */
  filename: string;
  /** Which download this is — the employee / company / scope caption printed under the title. */
  filterCaption?: string | null;
  /** The filters the file was taken under, printed on the sheet so it can be filed. */
  filterDescription?: string | null;
  /** The "named columns are blank where no per-item detail was saved" sentence, already translated.
   *  Printed ONLY when at least one row in the file actually lacks per-item detail. */
  detailNote?: string | null;
};

/** One dynamic column: the pay-item code it belongs to and the header it prints. */
type DynamicColumn = { code: string; header: string };

/**
 * Build the dynamic column list for one population of lines: one column per distinct CODE, ordered by
 * code, headed with the item's stored name.
 *
 * Two different codes can carry the same name (nothing stops an operator doing that), and two identical
 * headers on a reconciliation sheet is exactly the kind of ambiguity this file exists to remove — so a
 * shared name is disambiguated by its code rather than left to look like a duplicate column.
 */
function dynamicColumns(names: Map<string, string>, prefix: string): DynamicColumn[] {
  const codes = [...names.keys()].sort((a, b) => a.localeCompare(b));
  const baseOf = (code: string) => names.get(code) || code;
  const seen = new Map<string, number>();
  for (const code of codes) seen.set(baseOf(code), (seen.get(baseOf(code)) ?? 0) + 1);
  return codes.map((code) => {
    const base = baseOf(code);
    const label = (seen.get(base) ?? 0) > 1 && base !== code ? `${base} (${code})` : base;
    return { code, header: `${prefix}${label}` };
  });
}

/** Sum a payslip's lines by code. Two lines of one code in one payslip are ADDED, never last-wins — an
 *  export that silently drops half an item is the failure this file must not have. */
function amountsByCode(lines: { code: string; amount: number }[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of lines) out.set(l.code, (out.get(l.code) ?? 0) + num(l.amount));
  return out;
}

/**
 * Fold processed payslips into ONE wide table.
 *
 * `rows` arrive ALREADY scope-guarded from `listProcessedPayslipsAcross` via the route's `scopedAdmin()`;
 * this function introduces no authorisation of its own and must not be handed rows from anywhere else.
 */
export function buildHistoryExport(input: HistoryExportInput): ReportData {
  const rows = input.rows;
  const hrdfRegistered = new Set(input.hrdfRegisteredCompanyIds ?? []);
  const cycleLabels = input.cycleLabels ?? {};
  const statusLabels = input.statusLabels ?? {};

  // ── Pass 1: which dynamic columns exist across the WHOLE row set, and does any row lack detail? ──
  // A named item absent from a given payslip leaves that cell EMPTY rather than printing 0: a 0 asserts
  // "this employee got nothing under this heading this month", which is a different (and usually wrong)
  // statement from "this heading did not apply".
  const breakdowns = rows.map((r) => deriveHistoryBreakdown(r));
  const namedNames = new Map<string, string>();
  const recordedNames = new Map<string, string>();
  let anyDetailNotRecorded = false;
  for (const b of breakdowns) {
    // 862ed0ad — a run calculated before the per-item stamp existed, and every bonus / off-cycle /
    // adjustment run (which never stamps one), carries no component lines. Its summary figures and its
    // Allowances TOTAL are still exact; only the named columns are blank. The sheet SAYS so at the top
    // rather than leaving the reader to guess why a column is empty.
    if (b.detailNotRecorded) anyDetailNotRecorded = true;
    // Keep the first NON-EMPTY name seen for a code: a later run may name an item an earlier one did not,
    // and a column headed with a bare code when a name exists somewhere in the file is needless.
    for (const l of b.componentLines) if (!namedNames.get(l.code)) namedNames.set(l.code, l.name || '');
    for (const l of b.recordLines) if (!recordedNames.get(l.code)) recordedNames.set(l.code, l.name || '');
  }
  const namedCols = dynamicColumns(namedNames, '');
  const recordedCols = dynamicColumns(recordedNames, RECORDED_ITEM_PREFIX);

  const columns = [
    ...FIXED_COLUMNS.map((c) => c.label),
    ...namedCols.map((c) => c.header),
    ...recordedCols.map((c) => c.header),
  ];
  const align: ColAlign[] = [
    ...FIXED_COLUMNS.map((c) => c.align),
    ...namedCols.map((): ColAlign => 'right'),
    ...recordedCols.map((): ColAlign => 'right'),
  ];

  // ── Pass 2: one row per payslip, in the read's own order (newest period first, as on screen) ──
  const body: (string | number | null)[][] = rows.map((row, i) => {
    const b = breakdowns[i];
    const st = b.st;
    // 3c473773 issue 2 — the employee-borne figures, NOT the raw blob. See the header note.
    const emp = b.employerBorne.employee;
    const named = amountsByCode(b.componentLines);
    const recorded = amountsByCode(b.recordLines);
    return [
      row.payPeriod,
      cycleLabels[row.runType] ?? row.runType,
      row.employeeCode ?? '',
      row.employeeName,
      row.runSeq,
      row.company,
      statusLabels[row.batchStatus] ?? row.batchStatus,
      money(b.gross),
      money(emp.epf),
      money(emp.socso),
      money(emp.skbbk),
      money(emp.eis),
      money(emp.pcb),
      money(num(st.cp38)),
      money(num(st.zakat)),
      money(b.totalDeductions),
      money(b.net),
      money(b.basic),
      money(b.allowanceNet),
      money(b.otConvertAmount),
      money(b.overtime),
      money(b.bonus),
      money(b.claim),
      money(b.employerContributions.epf),
      money(b.employerContributions.socso),
      money(b.employerContributions.eis),
      // Blank, not 0, for a company outside the HRDF register — the screen says "Not registered" here and
      // a 0 in a column finance sums would read as a levy that failed to compute (feedback efece4ce).
      hrdfRegistered.has(row.companyId) ? money(b.employerContributions.hrdf) : '',
      money(b.employerContributions.total),
      ...namedCols.map((c) => (named.has(c.code) ? money(named.get(c.code)) : '')),
      ...recordedCols.map((c) => (recorded.has(c.code) ? money(recorded.get(c.code)) : '')),
    ];
  });

  return {
    filename: input.filename,
    title: input.title,
    columns,
    // No grand-total row is appended here, deliberately — see this file's header.
    rows: body,
    layout: {
      orientation: 'landscape',
      freeze: HISTORY_EXPORT_FREEZE,
      align,
      subtitle: input.filterCaption ?? null,
      description: input.filterDescription ?? null,
      header: anyDetailNotRecorded ? (input.detailNote ?? null) : null,
    },
  };
}
