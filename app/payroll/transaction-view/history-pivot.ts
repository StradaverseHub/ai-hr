import type { ProcessedPayslipViewRow } from '@/core/payroll-view';
import { deriveHistoryBreakdown } from './history-breakdown';

/**
 * Feedback 080de5cf — the spreadsheet PIVOT behind Transaction View › History › Grid.
 *
 * WHAT THIS IS, AND WHY IT IS NOT A RESTYLE. The payslip-by-payslip History table answers "show me the
 * payslips": one line per payslip, expand it to see what it was made of. The reporter's reference screen
 * answers a different question — "show me one person's YEAR": every pay item down the left, every month
 * across the top, an annual total on the right. Following one person's Basic Salary through a year on the
 * old table means opening twelve lines and reading a figure out of each. So this is the same information
 * turned on its side, and both views stay.
 *
 * A REGROUP, NEVER A RECOMPUTATION. Every figure here comes out of `deriveHistoryBreakdown` — i.e. out of
 * what the payslip STORED — and is only re-sliced by (item, run type, month). Re-deriving from today's pay
 * item assignments is what would let the grid disagree with the totals printed beside it on the very screen
 * whose purpose is reconciliation; the same rule the itemised breakdown already lives by.
 *
 * THE ROW KEY IS (item code, RUN TYPE), NOT THE ITEM. In the reference, GROSS appears four times and
 * Employee EPF twice — once per "Payment ID". That is our run type: ADR-0024 Wave 2C lets one (company,
 * month) hold several runs, and a bonus run and an end-month run are genuinely different lines. Two runs of
 * the SAME type in one month (runSeq 2) are the same line and are summed into the one month slot.
 *
 * WHAT THE REFERENCE HAS AND WE DO NOT. Its "Transaction ID" column (WEEK 2 / WEEK 4) has no equivalent in
 * our data — we record no week against a payroll run — so it is deliberately absent rather than invented.
 * The approved plan states that absence in as many words.
 *
 * TWO POPULATIONS OF ROW, and the difference is what the "hide system codes" switch acts on:
 *   • SYNTHETIC rows are derived from the payslip's stored aggregates and its statutory blob. They exist on
 *     every payslip ever generated, which is what keeps the grid useful for months that predate the
 *     per-item stamp (862ed0ad) and for additional runs, which never stamp one at all (core/payroll.ts
 *     writes componentLines on the REGULAR run only, so a bonus run has aggregates and nothing else).
 *   • ITEM rows are the pay items the payslip actually recorded — `componentLines` (the detail behind the
 *     summarised earnings/deductions) and `recordLines` (one-off provenance + record-only items). They
 *     carry the operator's own codes, which is what "each payroll item shall occupy its own row" asks for.
 * An item row RESTATES money already counted in a synthetic row above it, so it is marked
 * `reconciling: false` and no total on this screen is ever formed by adding the two populations together.
 *
 * THE RECONCILIATION INVARIANT (pinned by test/history-pivot.test.ts) is the one property that catches a
 * regroup bug, and it holds by construction rather than by arithmetic performed here:
 *     Σ months of the reconciling EARNING rows   = Σ payslip gross
 *     Σ months of the reconciling DEDUCTION rows = Σ payslip total deductions
 * Earnings reconcile because `basic + allowanceNet + otConvert + overtime + bonus + claim` IS gross (the
 * display overlay is stamped to reconcile with grossPay — core/payroll.ts). Deductions reconcile because
 * OTHER_DED is a RESIDUAL — total deductions less the named statutory lines — so whatever the kernel put in
 * `otherDeductions` (unpaid leave, manual deductions, loans, carry-forward) plus any policy rounding lands
 * there instead of leaving the column short. That is deliberate: a residual that is occasionally lumpy is a
 * far better failure than a column that silently does not add up.
 */

/** Which block of the grid a row belongs to. Ordered exactly as the sections are rendered/exported. */
export type GridRowGroup = 'earning' | 'deduction' | 'employer' | 'item' | 'summary';

const GROUP_ORDER: Record<GridRowGroup, number> = {
  earning: 0,
  deduction: 1,
  employer: 2,
  item: 3,
  summary: 4,
};

/**
 * The synthetic rows, in render order. `key` is also the i18n label key under
 * `payroll.transactions.view.grid.row.*` (resolved by the consumer — a computed t() key, so
 * test/history-pivot.test.ts asserts every one of them exists in en.json instead).
 *
 * `code` is what prints in the leftmost column. It is a DISPLAY code, not a pay-component code: nothing
 * stops an operator naming a real pay item "BASIC", which is why the row key below is namespaced by
 * `kind` — a synthetic BASIC and a pay item coded BASIC must never merge into one line.
 */
const SYNTHETIC: {
  key: string;
  code: string;
  group: GridRowGroup;
  /** Part of the mutually exclusive set whose column sum equals a stored payslip total. */
  reconciling: boolean;
}[] = [
  // ── Earnings: these six sum to gross, exactly ──
  { key: 'basic', code: 'BASIC', group: 'earning', reconciling: true },
  { key: 'allowance', code: 'ALLOW', group: 'earning', reconciling: true },
  // f3148da1 — the OT excess redirected to a pay item. Already folded into the stored allowance column, so
  // `allowanceNet` has it taken back out and it stands as its own line; together they still make gross.
  { key: 'otConvert', code: 'OT_CONV', group: 'earning', reconciling: true },
  { key: 'overtime', code: 'OT', group: 'earning', reconciling: true },
  { key: 'bonus', code: 'BONUS', group: 'earning', reconciling: true },
  { key: 'claim', code: 'CLAIM', group: 'earning', reconciling: true },
  // ── Deductions: these seven sum to total deductions, exactly (OTHER_DED absorbs the remainder) ──
  // 3c473773 issue 2 — the EMPLOYEE-BORNE figures, not the reported share. The employer-bears settings move
  // money onto the company and total deductions is already net of that; printing the reported share here
  // would put two contradictory numbers for one deduction on one screen (the defect that screen had).
  { key: 'epfEmployee', code: 'EPF_EE', group: 'deduction', reconciling: true },
  { key: 'socsoEmployee', code: 'SOCSO_EE', group: 'deduction', reconciling: true },
  { key: 'skbbk', code: 'SKBBK', group: 'deduction', reconciling: true },
  { key: 'eisEmployee', code: 'EIS_EE', group: 'deduction', reconciling: true },
  { key: 'pcb', code: 'PCB', group: 'deduction', reconciling: true },
  { key: 'cp38', code: 'CP38', group: 'deduction', reconciling: true },
  { key: 'otherDeductions', code: 'OTHER_DED', group: 'deduction', reconciling: true },
  // Zakat is INFORMATIONAL: PCB is already net of it (LHDN §E.5 offset), so adding it to the deduction
  // column would deduct it twice. Shown because an operator reconciling a Muslim employee's month expects
  // to see it; excluded from the reconciling set for the same reason it is muted on the payslip.
  { key: 'zakat', code: 'ZAKAT', group: 'deduction', reconciling: false },
  // ── Employer cost: never part of gross or net, so never part of a reconciling sum ──
  { key: 'epfEmployer', code: 'EPF_ER', group: 'employer', reconciling: false },
  { key: 'socsoEmployer', code: 'SOCSO_ER', group: 'employer', reconciling: false },
  { key: 'eisEmployer', code: 'EIS_ER', group: 'employer', reconciling: false },
  { key: 'hrdf', code: 'HRDF', group: 'employer', reconciling: false },
  { key: 'employerBorne', code: 'ER_BORNE', group: 'employer', reconciling: false },
  // ── Roll-ups: sums of the rows above, kept because the reference shows GROSS and NETPAY as lines ──
  { key: 'gross', code: 'GROSS', group: 'summary', reconciling: false },
  { key: 'totalDeductions', code: 'TOTAL_DED', group: 'summary', reconciling: false },
  { key: 'net', code: 'NETPAY', group: 'summary', reconciling: false },
];

/** Render order within a group, by synthetic key. */
const SYNTHETIC_ORDER = new Map(SYNTHETIC.map((s, i) => [s.key, i]));

/** Every i18n label key the grid resolves dynamically — asserted against en.json by the pivot test. */
export const SYNTHETIC_LABEL_KEYS: readonly string[] = SYNTHETIC.map((s) => s.key);

export type HistoryGridRow = {
  /** Stable identity: kind + group + code + run type. Kind and group are in the key so two different
   *  things carrying one code (a pay item coded BASIC vs the synthetic BASIC line; a cash item vs a
   *  record-only line) can never merge into one row and double a figure. */
  key: string;
  kind: 'synthetic' | 'item';
  /** Leftmost column — the reference's "ADCode". */
  code: string;
  /** Second column. For a synthetic row this is null and the consumer resolves
   *  `payroll.transactions.view.grid.row.<labelKey>`; for an item row it is the stored item name. */
  labelKey: string | null;
  name: string;
  /** Third column — the reference's "Payment ID". */
  runType: ProcessedPayslipViewRow['runType'];
  group: GridRowGroup;
  /** See the invariant note in this file's header. */
  reconciling: boolean;
  /** Twelve slots, index 0 = January. Months excluded by the filter stay 0 and their column is not shown. */
  months: number[];
  /** Sum of `months` — i.e. of the SHOWN months, so the row always adds up on screen. */
  total: number;
  /** HRDF only: not one payslip behind this row came from a company registered for the levy, so its 0 is a
   *  policy statement rather than a computation. The screen must say so — feedback efece4ce is exactly the
   *  ambiguity of an unregistered company looking like a levy that failed to compute. */
  notRegistered?: boolean;
};

export type HistoryGrid = {
  rows: HistoryGridRow[];
  /** Month numbers (1-12) whose columns are shown, ascending. */
  months: number[];
  /** How many payslips were folded — what the screen reports as its count. */
  payslipCount: number;
  /** At least one folded run predates the per-item stamp (862ed0ad) or is an additional run, which never
   *  stamps one. Its pay items were never written down and cannot be reconstructed, so the screen SAYS so
   *  rather than presenting a grid whose item rows are silently missing a month. */
  detailNotRecorded: boolean;
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown) => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};

const ALL_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

/** Coerce an untrusted month list (URL params) to ascending unique 1-12; empty ⇒ all twelve. */
export function cleanMonths(raw: string | string[] | undefined): number[] {
  const list = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
  const out = new Set<number>();
  for (const v of list) {
    // A comma-joined value is accepted too, so a hand-written link (?months=1,2,3) behaves like the form's
    // repeated params rather than silently selecting nothing.
    for (const part of String(v).split(',')) {
      const n = Number(part.trim());
      if (Number.isInteger(n) && n >= 1 && n <= 12) out.add(n);
    }
  }
  return out.size === 0 ? [...ALL_MONTHS] : [...out].sort((a, b) => a - b);
}

/** One contribution to a (kind, code, runType) row for one month. */
type Cell = {
  kind: 'synthetic' | 'item';
  code: string;
  labelKey: string | null;
  name: string;
  group: GridRowGroup;
  reconciling: boolean;
  amount: number;
};

/**
 * Everything one payslip contributes, as flat cells. Reads ONLY `deriveHistoryBreakdown` — the payslip's
 * own stored figures — so a category or a rate changed after the run cannot rewrite what it says.
 */
function cellsFor(row: ProcessedPayslipViewRow): { cells: Cell[]; detailNotRecorded: boolean } {
  const b = deriveHistoryBreakdown(row);
  const st = b.st;
  const emp = b.employerBorne.employee;
  // The residual. `totalDeductions = statDeductions + otherDeductions` is a kernel invariant
  // (core/payroll.ts), and CP38 rides inside otherDeductions, so subtracting the named lines leaves exactly
  // the unpaid-leave / manual / loan / carry-forward money plus any policy rounding applied to the total.
  // Left unclamped on purpose: a carry-forward DEFERRAL is legitimately negative, and hiding that behind a
  // Math.max would make the column stop adding up in the one case worth seeing.
  const cp38 = num(st.cp38);
  const otherDeductions = round2(
    b.totalDeductions - (emp.epf + emp.socso + emp.skbbk + emp.eis + emp.pcb) - cp38,
  );

  const amounts: Record<string, number> = {
    basic: b.basic,
    allowance: b.allowanceNet,
    otConvert: b.otConvertAmount,
    overtime: b.overtime,
    bonus: b.bonus,
    claim: b.claim,
    epfEmployee: emp.epf,
    socsoEmployee: emp.socso,
    skbbk: emp.skbbk,
    eisEmployee: emp.eis,
    pcb: emp.pcb,
    cp38,
    otherDeductions,
    zakat: num(st.zakat),
    epfEmployer: b.employerContributions.epf,
    socsoEmployer: b.employerContributions.socso,
    eisEmployer: b.employerContributions.eis,
    hrdf: b.employerContributions.hrdf,
    employerBorne: b.employerBorne.total,
    gross: b.gross,
    totalDeductions: b.totalDeductions,
    net: b.net,
  };

  const cells: Cell[] = SYNTHETIC.map((s) => ({
    kind: 'synthetic' as const,
    code: s.code,
    labelKey: s.key,
    // The OT-conversion line names the pay item the excess was paid as, when the payslip recorded one.
    name: s.key === 'otConvert' && st.otConvert?.name ? st.otConvert.name : '',
    group: s.group,
    reconciling: s.reconciling,
    amount: amounts[s.key] ?? 0,
  }));

  // ── Item rows: the pay items as the payslip recorded them ──
  for (const l of b.componentLines) {
    // A line can straddle two buckets (an exempt portion paid untaxed plus a taxable remainder); `amount`
    // is the whole resolved figure before that split, which is the item as an operator keyed it. The split
    // matters to the statutory bases, not to "what did this employee get paid".
    const isDeduction = l.buckets.length > 0 && l.buckets.every((x) => x.bucket === 'deduct');
    cells.push({
      kind: 'item',
      code: l.code,
      labelKey: null,
      name: l.name || l.code,
      group: isDeduction ? 'deduction' : 'earning',
      reconciling: false,
      amount: num(l.amount),
    });
  }
  for (const l of b.recordLines) {
    cells.push({
      kind: 'item',
      code: l.code,
      labelKey: null,
      name: l.name || l.code,
      group: 'item',
      reconciling: false,
      amount: num(l.amount),
    });
  }
  // 862ed0ad — a run stamped before the per-item detail existed, or an additional run (which never stamps
  // one), contributes no item rows at all. Reported rather than left to look like a gap in the data.
  return { cells, detailNotRecorded: b.detailNotRecorded };
}

/**
 * Fold processed payslips into the grid.
 *
 * `rows` arrive ALREADY scope-guarded from `listProcessedPayslipsAcross` via the page's `scopedAdmin()` —
 * this function introduces no authorisation of its own and must not be handed rows from anywhere else.
 */
export function pivotHistoryGrid(p: {
  rows: ProcessedPayslipViewRow[];
  /** The calendar year the twelve columns belong to. A payslip from any other year is ignored. */
  year: number;
  /** Months (1-12) to include; a payslip outside them contributes nothing at all, so the row totals match
   *  the columns on screen. Defaults to all twelve. */
  months?: number[];
  /** Companies whose HRD Corp levy is registered (efece4ce). */
  hrdfRegisteredCompanyIds?: string[];
}): HistoryGrid {
  const months = p.months && p.months.length > 0 ? [...new Set(p.months)].sort((a, b) => a - b) : [...ALL_MONTHS];
  const shown = new Set(months);
  const hrdfRegistered = new Set(p.hrdfRegisteredCompanyIds ?? []);
  const yearPrefix = `${p.year}-`;

  const acc = new Map<string, HistoryGridRow>();
  let payslipCount = 0;
  let detailNotRecorded = false;
  // Tracked across the whole fold rather than per row: HRDF is one line, and it may be fed by payslips from
  // two companies if the employee moved mid-year.
  let anyHrdfRegistered = false;

  for (const row of p.rows) {
    if (!row.payPeriod.startsWith(yearPrefix)) continue;
    const month = Number(row.payPeriod.slice(5, 7));
    if (!Number.isInteger(month) || !shown.has(month)) continue;
    payslipCount += 1;
    if (hrdfRegistered.has(row.companyId)) anyHrdfRegistered = true;

    const slip = cellsFor(row);
    if (slip.detailNotRecorded) detailNotRecorded = true;
    for (const c of slip.cells) {
      // `kind` and `group` are in the key, not just the code. Two DIFFERENT things can carry one code and
      // must never be summed into a single line: the synthetic BASIC row and a pay item an operator coded
      // BASIC; a cash pay item and a record-only line of the same code (f1564110 Phase 3 merges consumed
      // one-off transactions into recordLines by name); an item that was an earning in January and a
      // deduction in March. Each of those merges would double a figure on a reconciliation screen and look
      // entirely plausible while doing it.
      const key = `${c.kind}:${c.group}:${c.code}:${row.runType}`;
      let target = acc.get(key);
      if (!target) {
        target = {
          key,
          kind: c.kind,
          code: c.code,
          labelKey: c.labelKey,
          name: c.name,
          runType: row.runType,
          group: c.group,
          reconciling: c.reconciling,
          months: new Array(12).fill(0),
          total: 0,
        };
        acc.set(key, target);
      }
      // A later payslip may carry a name where an earlier one did not (the OT-conversion line, or an item
      // renamed between runs) — keep the first non-empty one so the description column is never blank.
      if (!target.name && c.name) target.name = c.name;
      target.months[month - 1] = round2(target.months[month - 1] + c.amount);
    }
  }

  const rows = [...acc.values()];
  for (const r of rows) {
    r.total = round2(r.months.reduce((s, m) => s + m, 0));
    if (r.kind === 'synthetic' && r.labelKey === 'hrdf' && !anyHrdfRegistered) r.notRegistered = true;
  }

  rows.sort((a, b) => {
    const g = GROUP_ORDER[a.group] - GROUP_ORDER[b.group];
    if (g !== 0) return g;
    // Synthetic rows keep their editorial order; item rows sort by code, as the reference does.
    const ao = a.kind === 'synthetic' ? (SYNTHETIC_ORDER.get(a.labelKey ?? '') ?? 0) : Number.MAX_SAFE_INTEGER;
    const bo = b.kind === 'synthetic' ? (SYNTHETIC_ORDER.get(b.labelKey ?? '') ?? 0) : Number.MAX_SAFE_INTEGER;
    if (ao !== bo) return ao - bo;
    const c = a.code.localeCompare(b.code);
    if (c !== 0) return c;
    return a.runType.localeCompare(b.runType);
  });

  return { rows, months, payslipCount, detailNotRecorded };
}

/**
 * The two switches from the reference, applied to a built grid. Client-side over already-fetched rows, and
 * the export takes the SAME two flags off the URL so the file matches the screen it was taken from.
 *
 *   hideZero   — drop a row whose every shown month is 0. A row of zeroes carries no information, which is
 *                why the reference has this ticked by default and so do we.
 *   hideSystem — drop the SYNTHETIC rows, leaving the pay items the operator actually keyed. Off by
 *                default, because unlike the reference our synthetic set carries the statutory lines and a
 *                run with no stored item detail would otherwise render as an empty grid.
 */
export function filterGridRows(
  rows: HistoryGridRow[],
  opts: { hideZero: boolean; hideSystem: boolean },
): HistoryGridRow[] {
  return rows.filter((r) => {
    if (opts.hideSystem && r.kind === 'synthetic') return false;
    // `notRegistered` survives hide-zero on purpose. Its zeroes are a POLICY STATEMENT — the company is
    // not registered for the levy — and hide-zero exists to drop rows that carry no information. Letting
    // the default switch delete the one row that explains itself would recreate feedback efece4ce, where
    // an unregistered company was indistinguishable from a levy that failed to compute.
    if (opts.hideZero && !r.notRegistered && r.months.every((m) => m === 0)) return false;
    return true;
  });
}
