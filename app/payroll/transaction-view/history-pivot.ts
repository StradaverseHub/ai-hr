import type { ProcessedPayslipViewRow } from '@/core/payroll-view';
// 417d4937 — the shared read-time repair for RECORD-line labels (and the shared code+description format).
// Pure and dependency-free, so this pure pivot stays pure.
import { recordLineIdentity, type PayItemNames } from '@/core/payslip-earning-lines';
// 3c88d593 (r206) — which days of the period a payslip claims, read from the payslip's OWN record.
// Pure and dependency-free for the same reason as the import above.
import { payslipSegmentOf, type PayslipCoverage } from '@/core/payslip-segment';
// 3a092cf0 — whether THIS payslip's stored total already counts its zakat. Pure and dependency-free,
// like the two above, so this pure pivot stays pure.
import { payslipZakatLine, type PayslipZakatSnapshot } from '@/core/payslip-zakat-line';
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
 * THE ROW KEY IS (COMPANY, item code, RUN TYPE), NOT THE ITEM. In the reference, GROSS appears four times
 * and Employee EPF twice — once per "Payment ID". That is our run type: ADR-0024 Wave 2C lets one (company,
 * month) hold several runs, and a bonus run and an end-month run are genuinely different lines. Two runs of
 * the SAME type in one month (runSeq 2) are the same line and are summed into the one month slot.
 *
 * 3c88d593 (r206) — AND THE PAYING COMPANY IS IN THAT KEY. Until r206 it was not, so two payslips for the
 * same (item, run type, month) issued by DIFFERENT employers summed into one cell: an employee who
 * transferred entity on 11 August had Fiamma's 1–10 August and ISEDECOR BINA's 11–31 August added together
 * under one "August" column, with nothing on screen saying a transfer had happened. Note this was never
 * only a transfer-MONTH fault — someone who moved in March had Jan–Feb of one employer and Mar–Dec of
 * another silently mixed in the same rows for the whole year.
 *
 * NOT ONE FIGURE MOVES. Splitting a key PARTITIONS the payslips behind it: the same amounts land on two
 * lines instead of one, so every month column and every reconciling sum is arithmetically identical — 1,000
 * plus 2,100 is still the 3,100 it was, shown on the two lines it was actually paid on. That is why the
 * reconciliation invariant below survives by construction rather than by anything computed here.
 *
 * WHAT THE REFERENCE HAS AND WE DO NOT. Its "Transaction ID" column (WEEK 2 / WEEK 4) has no equivalent in
 * our data — we record no week against a payroll run — so it is deliberately absent rather than invented.
 * The approved plan states that absence in as many words.
 *
 * TWO POPULATIONS OF ROW, and the difference is what the "hide system codes" switch acts on:
 *   • SYNTHETIC rows are derived from the payslip's stored aggregates and its statutory blob. They exist on
 *     every payslip ever generated, which is what keeps the grid useful for months that predate the
 *     per-item stamp (862ed0ad) and for additional runs calculated before 6b134681, which stamped nothing
 *     at all. From 6b134681 an additional run DOES stamp — its bonus-bucket lines, and only those, so the
 *     item rows on a bonus run sum to the bonus figure rather than restating a whole month of allowances.
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

/**
 * ── Feedback 0253dc7c (r193) — THE WORKING BETWEEN THE ITEMS AND THE ANSWERS, ON SCREEN ────────────
 *
 * "The wage each contribution was charged on has been recorded against every recent payroll run, and
 * it appears nowhere on screen, so the only way to check a figure is to redo the arithmetic by hand."
 * Three additions, all of them DISCLOSURE — not one figure is recomputed anywhere in this file:
 *
 *   1. A WAGE BASE block, rendered LAST, straight out of `statutory.bases` (r187's stamp). Every one
 *      of its rows is `reconciling: false`, so the two reconciliation invariants below are untouched.
 *      A run with no stamp renders an em dash and sets `basesNotRecorded`; it NEVER borrows grossPay.
 *   2. STATUTORY SUBJECT columns (EPF / SOCSO / EIS / SKBBK / Tax, Y or N) behind a new switch,
 *      preferring the tick the payslip itself stamped (r193) and falling back to today's catalogue.
 *   3. The ALLOW and OTHER_DED lump-sum rows drop out on their own once the item rows fully account
 *      for them — which is the reporter's actual request, without breaking `Hide system codes`
 *      (all-or-nothing by design) for the people who use it.
 */

/** Which block of the grid a row belongs to. Ordered exactly as the sections are rendered/exported. */
export type GridRowGroup = 'wagebase' | 'earning' | 'deduction' | 'employer' | 'item' | 'summary';

const GROUP_ORDER: Record<GridRowGroup, number> = {
  // 0253dc7c — the wage base block sorts LAST (highest rank), sitting at the bottom of the Transaction
  // Detail table below the earnings, deductions, employer cost and roll-ups.
  earning: 0,
  deduction: 1,
  employer: 2,
  item: 3,
  summary: 4,
  wagebase: 5,
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
  // ── Wage bases (0253dc7c): what each agency was CHARGED ON. Never part of any reconciling sum —
  // a base is not money that moved, and adding one to a column of payments would be nonsense.
  //
  // SOCSO, EIS and SKBBK are THREE CAPTIONS OVER ONE STORED FIGURE (`bases.socsoEis`). SKBBK is
  // charged on the SOCSO wage and there is no separate base for it anywhere in the schema; the three
  // rows will therefore always agree, and that is a fact about the law, not a copy-paste bug.
  { key: 'epfWages', code: 'EPF_WAGE', group: 'wagebase', reconciling: false },
  // Emitted ONLY when the run recorded a non-zero additional-remuneration EPF base, so a month with
  // no bonus grows no row at all rather than a line of zeroes on every payslip ever produced.
  { key: 'epfAdditionalWages', code: 'EPF_ADD_WAGE', group: 'wagebase', reconciling: false },
  { key: 'socsoWages', code: 'SOCSO_WAGE', group: 'wagebase', reconciling: false },
  { key: 'eisWages', code: 'EIS_WAGE', group: 'wagebase', reconciling: false },
  { key: 'skbbkWages', code: 'SKBBK_WAGE', group: 'wagebase', reconciling: false },
  { key: 'pcbWages', code: 'PCB_WAGE', group: 'wagebase', reconciling: false },
  { key: 'hrdfWages', code: 'HRDF_WAGE', group: 'wagebase', reconciling: false },
  // ── Earnings: these six sum to gross, exactly ──
  { key: 'basic', code: 'BASIC', group: 'earning', reconciling: true },
  { key: 'allowance', code: 'ALLOW', group: 'earning', reconciling: true },
  // f3148da1 — the OT excess redirected to a pay item. Already folded into the stored allowance column, so
  // `allowanceNet` has it taken back out and it stands as its own line; together they still make gross.
  { key: 'otConvert', code: 'OT_CONV', group: 'earning', reconciling: true },
  { key: 'overtime', code: 'OT', group: 'earning', reconciling: true },
  { key: 'bonus', code: 'BONUS', group: 'earning', reconciling: true },
  { key: 'claim', code: 'CLAIM', group: 'earning', reconciling: true },
  // ── Deductions: these eight sum to total deductions, exactly (OTHER_DED absorbs the remainder) ──
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
  // 3a092cf0 REVERSES THIS ROW'S DECISION, and the reasoning it replaces is worth stating because it
  // sounds right. It read: "Zakat is INFORMATIONAL: PCB is already net of it (LHDN §E.5 offset), so adding
  // it to the deduction column would deduct it twice." The premise is true and the conclusion does not
  // follow. `pcb` on the row beside it is ALREADY the post-offset figure, so where the tax exceeded the
  // zakat the column has already fallen by the whole amount and adding the ZAKAT row back leaves the sum
  // unchanged. Where it did not — a tax under the RM10 remittance floor, which is SIG01's shape — the
  // zakat was never taken off anything and excluding it left the column short by exactly the money the
  // employee owed. The kernel now charges it (core/payroll.ts `statDeductions`), so a total that excluded
  // it would no longer be the payslip's total at all.
  { key: 'zakat', code: 'ZAKAT', group: 'deduction', reconciling: true },
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
  /** Stable identity: kind + group + code + run type + COMPANY. Kind and group are in the key so two
   *  different things carrying one code (a pay item coded BASIC vs the synthetic BASIC line; a cash item vs
   *  a record-only line) can never merge into one row and double a figure; the company is in it (3c88d593)
   *  so two EMPLOYERS' figures for one month can never merge into one cell and hide a transfer. */
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
  /** 3c88d593 — the PAYING company. Part of the row key, and the fourth column on screen. An employee who
   *  never changed entity gets the same one name repeated down it and rows identical to before. */
  companyId: string;
  company: string;
  /**
   * 3c88d593 — the coverage windows this row's payslips claimed, when any of them claimed LESS than the
   * whole pay period. Distinct and ascending; EMPTY on every row whose payslips each covered their whole
   * month, which is every payslip this system issued until somebody transferred entity mid-month.
   *
   * A LIST rather than one window because a row spans up to twelve months and each month's slip carries
   * its own claim — the outgoing employer's row is a full January through to a 1–10 August. Read from the
   * payslip's OWN record (`payslipSegmentOf`), NEVER re-derived from today's assignment history: a
   * correction made after the run must not be able to restate what an issued document covered.
   */
  segments?: PayslipCoverage[];
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
  /**
   * 0253dc7c, WAGE BASE ROWS ONLY. `true` at month i ⇒ a payslip DID contribute to that cell but
   * carried no `statutory.bases` (a run from before r187), so the base is unknown. The screen renders
   * an em dash there and the row total sums only the months that were recorded.
   *
   * ⚠️ THIS IS NOT "the base was zero". Rendering 0.00 there — or substituting grossPay, which is the
   * tempting fix — would put a WRONG wage base on the one screen whose entire purpose is checking a
   * figure by hand. 61 of the 121 production payslips are in this state.
   *
   * A month with NO payslip at all is left as a plain 0, exactly like every other row on the grid:
   * "nobody was paid that month" is already what a zero means here.
   */
  unrecordedMonths?: boolean[];
  /**
   * 0253dc7c — the pay item's statutory subject flags, for the Y/N columns. Present only on a row
   * whose code IS a pay item (every item row, plus the synthetic rows whose display code happens to
   * be a real component code — BASIC is the one the ticket names). `null`/absent ⇒ the columns stay
   * blank for that row, which is what "rows that are not pay items should remain blank" asks for.
   *
   * ONE `socso` ANSWER DRIVES THREE COLUMNS (SOCSO, EIS, SKBBK): `included_in_socso_eis` is a single
   * setting and there is no per-item SKBBK column in the schema. Do not invent one.
   */
  subject?: PayItemSubject | null;
  /**
   * 0253dc7c — the lump-sum row (ALLOW / OTHER_DED) is FULLY accounted for by the item rows below it,
   * in EVERY contributing month, so `filterGridRows` drops it. Row-level and never cell-level:
   * blanking one month of a row would break the row total, which is the property this screen exists
   * for. A month that does not reconcile — a residual holding a loan or a carry-forward deferral, or
   * a run with no stored item detail — keeps the whole row.
   */
  itemised?: boolean;
};

/** A pay item's statutory subject answers, and where this screen got them from. */
export type PayItemSubject = {
  epf: boolean;
  /** `included_in_socso_eis` — ONE setting behind the SOCSO, EIS and SKBBK columns. */
  socso: boolean;
  pcb: boolean;
  /**
   * 'payslip' — the tick the run itself stamped (r193 onward), i.e. what was true when that pay was
   * calculated. 'catalogue' — today's Pay Item setting, used for every payslip that predates the
   * stamp. The screen says which it is showing, because the two can legitimately disagree and an
   * unlabelled Y beside an old figure is exactly the confusion this item was raised about.
   */
  source: 'payslip' | 'catalogue';
};

/** The tenant's live Pay Item settings, keyed by code — read on the SERVER and passed in as data. */
export type PayItemSubjectMap = Record<string, { epf: boolean; socso: boolean; pcb: boolean }>;

/**
 * 0253dc7c — the five statutory-subject columns, in the reporter's order, declared ONCE.
 *
 * THREE OF THEM READ ONE FIELD. `included_in_socso_eis` is a single setting and there is no per-item
 * SKBBK column anywhere in the schema (SKBBK is charged on the SOCSO wage), so SOCSO, EIS and SKBBK
 * always agree and the caption under the table says so. Do not invent a third field to make them
 * look independent.
 *
 * It lives in this pure module rather than in the client component because THREE files consume it —
 * the screen, the export route and the i18n-resolution test — and a header order that disagrees with
 * a cell order produces a spreadsheet whose columns are silently mislabelled. `key` is also the i18n
 * key under `payroll.transactions.view.grid.subject.*`, resolved with a computed t() the static scan
 * cannot see, which is why the test asserts over this list rather than a copy of it.
 */
export const SUBJECT_COLUMNS: readonly { key: string; read: 'epf' | 'socso' | 'pcb' }[] = [
  { key: 'epf', read: 'epf' },
  { key: 'socso', read: 'socso' },
  { key: 'eis', read: 'socso' },
  { key: 'skbbk', read: 'socso' },
  { key: 'tax', read: 'pcb' },
];

export type HistoryGrid = {
  rows: HistoryGridRow[];
  /** Month numbers (1-12) whose columns are shown, ascending. */
  months: number[];
  /** How many payslips were folded — what the screen reports as its count. */
  payslipCount: number;
  /** At least one folded run predates the per-item stamp it needed — 862ed0ad for a regular run, and
   *  6b134681 for an additional one, which until then stamped nothing at all and now stamps its
   *  bonus-bucket lines. Its pay items were never written down and cannot be reconstructed, so the screen
   *  SAYS so rather than presenting a grid whose item rows are silently missing a month. It is ONLY ever
   *  "calculated too early" now; "this run type deliberately keeps no detail" is a dead rule, and
   *  `payroll.transactions.view.grid.detailNotRecorded` was reworded in all six catalogues to match. */
  detailNotRecorded: boolean;
  /** 0253dc7c — at least one folded run predates r187's `statutory.bases` stamp, so part of the wage
   *  base block is em dashes. Drives a caption; the alternative (a plausible-looking substitute) is
   *  the one outcome this disclosure must never produce. */
  basesNotRecorded: boolean;
  /** 0253dc7c — at least one subject answer on screen came from TODAY'S catalogue rather than from
   *  the payslip's own stamp, so the caption must say that a setting changed since a run could make
   *  the Y/N disagree with the figures above it. */
  subjectFromCatalogue: boolean;
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
  /** 0253dc7c, wage-base cells only: this payslip carried no `statutory.bases`, so the base is
   *  UNKNOWN rather than zero. See `HistoryGridRow.unrecordedMonths`. */
  unrecorded?: boolean;
  /** 0253dc7c, item rows only: the ticks this run stamped on the line. Undefined on every payslip
   *  written before r193, which is what makes the catalogue fallback necessary rather than optional. */
  stampedSubject?: { epf: boolean; socso: boolean; pcb: boolean };
};

/**
 * Everything one payslip contributes, as flat cells. Reads ONLY `deriveHistoryBreakdown` — the payslip's
 * own stored figures — so a category or a rate changed after the run cannot rewrite what it says.
 *
 * `lumpAccounted` reports, for THIS payslip, whether the ALLOW and OTHER_DED lump sums are fully
 * explained by the item rows it stamped. Computed here because this is where both halves are in scope.
 */
function cellsFor(row: ProcessedPayslipViewRow, payItemNames?: PayItemNames): {
  cells: Cell[];
  detailNotRecorded: boolean;
  basesNotRecorded: boolean;
  lumpAccounted: { allowance: boolean; otherDeductions: boolean };
} {
  const b = deriveHistoryBreakdown(row);
  const st = b.st;
  const emp = b.employerBorne.employee;
  // The residual. `totalDeductions = statDeductions + otherDeductions` is a kernel invariant
  // (core/payroll.ts), and CP38 rides inside otherDeductions, so subtracting the named lines leaves exactly
  // the unpaid-leave / manual / loan / carry-forward money plus any policy rounding applied to the total.
  // Left unclamped on purpose: a carry-forward DEFERRAL is legitimately negative, and hiding that behind a
  // Math.max would make the column stop adding up in the one case worth seeing.
  // ── 970e4143 — THE CP38 ROW HERE PRINTED WHAT WAS DEMANDED, NOT WHAT WAS TAKEN ─────────────────────
  //
  // ⚠️ THIS FILE WAS DECLARED CLEAN OF CP38 BY A GREP THAT COULD NOT SEE IT. `pKey` below joins its
  // composite key with a literal NUL byte, which makes `grep` classify this source file as BINARY and skip
  // it in a recursive search — silently, exit 0. That is how a survey of "every surface that prints a CP38
  // beside a total" missed the reconciliation GRID. Use `grep -a` on this directory.
  //
  // The double count fault never applied here: OTHER_DED is a residual struck from `totalDeductions` less
  // the named lines, so whatever is subtracted on the CP38 row comes straight back out of the residual and
  // the column adds up either way. The OVERSTATEMENT fault did apply, and this is a money screen: on a
  // clamped instalment `st.cp38` is the pre-clamp figure, so a 9,000 direction against 6,500 of pay printed
  // CP38 9,000.00 — and drove OTHER_DED to -3,393.35, a negative "Other deductions" that survives
  // hide-zero and reaches the operator.
  //
  // `cp38Lumped` is the shared answer for a row set with no named absence lines, which is this one. Read as
  // a pair with the subtraction below: a legacy clamped slip answers `show: false`, the row prints nothing
  // and its money stays inside OTHER_DED, exactly as the payslip surfaces degrade it.
  const cp38 = b.cp38Lumped.show ? b.cp38Lumped.amount : 0;
  // 3a092cf0 — ZAKAT COMES OUT OF THE RESIDUAL TOO, and leaving it in was the second half of the same
  // defect. `totalDeductions` now includes the zakat, so a residual that did not subtract it would carry
  // the zakat into OTHER_DED while the ZAKAT row printed it again beside it: the same 30.00 on two lines,
  // an over-stated "Other deductions" on a reconciliation screen, and no way for an operator to tell
  // which line was the real one. The rule this file lives by is that every named line is taken OUT of the
  // residual before it is printed; zakat is a named line now, so it is subtracted here.
  // 3a092cf0 — SUBTRACT THE ZAKAT ONLY FROM A SLIP WHOSE TOTAL ACTUALLY CONTAINS IT.
  //
  // `b.totalDeductions` is the STORED figure. On a slip written before this item that total EXCLUDES the
  // zakat, so subtracting a named zakat line out of it drives the residual NEGATIVE — measured against
  // SIG01's real stored row: "Other deductions -30.00", and filterGridRows only hides a row when EVERY
  // month is zero, so the negative survives hide-zero and reaches the screen.
  //
  // The payslip's own stamp is the authority (core/payslip-zakat-line.ts). Counted ⇒ it is inside the
  // total and comes out of the residual. Not counted ⇒ it was never in the total, so the residual is
  // computed exactly as it was before this round and the pre-existing slip is byte-identical.
  const zakatLine = payslipZakatLine(st as PayslipZakatSnapshot);
  const zakat = zakatLine.amount;
  const otherDeductions = round2(
    b.totalDeductions -
      (emp.epf + emp.socso + emp.skbbk + emp.eis + emp.pcb) -
      cp38 -
      (zakatLine.countedInTotal ? zakat : 0),
  );

  // 0253dc7c — the wage bases, straight out of the payslip's own stamp. `null` (a pre-r187 run) is
  // carried as UNKNOWN all the way to the screen; `?? 0` here would be the substitution the plan
  // forbids, so the amount is only ever read when `bases` exists.
  const bases = b.bases;
  const baseAmounts: Record<string, number> = {
    epfWages: bases?.epf ?? 0,
    epfAdditionalWages: bases?.epfAdditional ?? 0,
    // ONE stored figure, three captions — SKBBK is charged on the SOCSO wage (see the SYNTHETIC note).
    socsoWages: bases?.socsoEis ?? 0,
    eisWages: bases?.socsoEis ?? 0,
    skbbkWages: bases?.socsoEis ?? 0,
    pcbWages: bases?.pcb ?? 0,
    hrdfWages: bases?.hrdf ?? 0,
  };

  const amounts: Record<string, number> = {
    ...baseAmounts,
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
    zakat,
    epfEmployer: b.employerContributions.epf,
    socsoEmployer: b.employerContributions.socso,
    eisEmployer: b.employerContributions.eis,
    hrdf: b.employerContributions.hrdf,
    employerBorne: b.employerBorne.total,
    gross: b.gross,
    totalDeductions: b.totalDeductions,
    net: b.net,
  };

  const cells: Cell[] = SYNTHETIC
    // 0253dc7c — the additional-remuneration EPF base is a row only when this run actually had one.
    // Every other wage-base row is emitted always (an em dash is information; a missing row is not),
    // but a line of zeroes on every payslip ever produced for a company that pays no bonus is noise.
    .filter((s) => s.key !== 'epfAdditionalWages' || (bases != null && bases.epfAdditional !== 0))
    .map((s) => ({
      kind: 'synthetic' as const,
      code: s.code,
      labelKey: s.key,
      // The OT-conversion line names the pay item the excess was paid as, when the payslip recorded one.
      name: s.key === 'otConvert' && st.otConvert?.name ? st.otConvert.name : '',
      group: s.group,
      reconciling: s.reconciling,
      amount: amounts[s.key] ?? 0,
      // A wage-base cell on a run that never stamped one is UNKNOWN, not zero.
      ...(s.group === 'wagebase' && bases == null ? { unrecorded: true } : {}),
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
      // 0253dc7c — the ticks THIS run stamped, when it stamped any. `l.epf` is undefined on every
      // payslip written before r193, and `undefined` must not collapse to false: an item read as
      // "not subject to EPF" when nobody recorded an answer is a wrong Y/N, which is the whole
      // failure this disclosure exists to prevent. Hence the explicit presence test.
      ...(typeof l.epf === 'boolean'
        ? { stampedSubject: { epf: l.epf, socso: l.socso === true, pcb: l.pcb === true } }
        : {}),
    });
  }
  // 417d4937 — the RECORD lines, repaired at read time. Until r196 the kernel named a consumed one-off's
  // record line from the transaction's free-text remark, and that fix reaches only runs calculated AFTER
  // it — so an already-calculated payroll keeps "A0020 - DIRECTOR FEE" against pay item A0040 on this
  // grid forever unless the screen reads the catalogue. `recordLineIdentity` is the shared rule (and the
  // one place rule (a) of core/payslip-earning-lines.ts is deliberately reversed, for record lines only).
  // The CODE and the AMOUNT are untouched, and a code the catalogue does not hold — every TXN_* synthetic
  // line — keeps its stored name by construction.
  //
  // THE REMARK IS DELIBERATELY NOT SHOWN HERE, and this is the one surface where that is right. A grid row
  // is a PIVOT: one line spans twelve months and therefore several payslips, each of which may carry a
  // different remark against the same code. Printing one of them would attribute a month's typed words to
  // the whole year. The per-payslip surfaces (History's Recorded items, Individual Payslip, the ESS
  // payslip) each show a single slip and do print it.
  for (const l of b.recordLines) {
    cells.push({
      kind: 'item',
      code: l.code,
      labelKey: null,
      // `.name`, NOT `.label` — the Grid already has a `code` column of its own (history-grid.tsx renders
      // r.code in a sticky column; grid-export writes code and description as two cells), so `.label`
      // printed it twice: `A0040 | A0040 · MEAL ALLOWANCE`, while the componentLines row built 30 lines
      // above reads `A0040 | MEAL ALLOWANCE`. history-export.ts reasoned exactly this way for its column
      // headings; the Grid is where it is most literally true and it was missed.
      name: recordLineIdentity(l, payItemNames).name || l.name || l.code,
      group: 'item',
      reconciling: false,
      amount: num(l.amount),
    });
  }
  // ── 0253dc7c — is each lump-sum row fully explained by the item rows above? ──────────────────────
  // The reporter wants Allowances and Other deductions gone, and they can go the moment the named
  // items behind them add up to the same money. A payslip with NO stored item detail can never
  // satisfy this (nothing accounts for the figure), and neither can a residual holding a loan, a
  // carry-forward deferral or policy rounding that no pay item produced.
  //
  // Both tests are "is the figure zero, or do the items make it exactly?" — never "close enough".
  // The 0.005 tolerance is one tenth of a cent, present only because these are sums of 2dp figures.
  const bucketSum = (...want: string[]) =>
    round2(
      b.componentLines.reduce(
        (s, l) => s + (l.buckets ?? []).reduce((t, x) => t + (want.includes(x.bucket) ? num(x.amount) : 0), 0),
        0,
      ),
    );
  const hasDetail = b.componentLines.length > 0;
  // `allowanceNet` is `allowanceApplied + reimburse` (the OT-converted excess is taken back out and
  // stands as its own line), which is exactly the wage + reimburse buckets — including a component
  // that SPLIT across both because part of it was exempt. If the display overlay re-categorised
  // money into the allowance box from elsewhere the sums stop agreeing and the row correctly stays.
  const lumpAccounted = {
    allowance: b.allowanceNet === 0 || (hasDetail && Math.abs(bucketSum('wage', 'reimburse') - b.allowanceNet) < 0.005),
    otherDeductions:
      otherDeductions === 0 || (hasDetail && Math.abs(bucketSum('deduct') - otherDeductions) < 0.005),
  };

  // 862ed0ad — a run stamped before the per-item detail existed (including an additional run calculated
  // before 6b134681 gave it its own bonus-only stamp) contributes no item rows at all. Reported rather
  // than left to look like a gap in the data.
  return { cells, detailNotRecorded: b.detailNotRecorded, basesNotRecorded: bases == null, lumpAccounted };
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
  /**
   * 0253dc7c — the tenant's LIVE Pay Item settings, keyed by code. Read on the server (this file is
   * pure and does no I/O) and used ONLY where a payslip did not stamp its own answer: a run from
   * before r193 has no ticks recorded, and a blank column there would be less useful than today's
   * setting clearly labelled as today's setting. Omitted ⇒ only stamped answers are shown.
   */
  payItemSubjects?: PayItemSubjectMap;
  /**
   * 417d4937 — code → the pay item's CURRENT description, read on the server beside `payItemSubjects`.
   * Used ONLY to repair a RECORD line's label (see `recordLineIdentity`); `componentLines` keep the
   * payslip's own stamped name, which was never the thing that was wrong. Omitted ⇒ stored names stand.
   */
  payItemNames?: PayItemNames;
}): HistoryGrid {
  const months = p.months && p.months.length > 0 ? [...new Set(p.months)].sort((a, b) => a - b) : [...ALL_MONTHS];
  const shown = new Set(months);
  const hrdfRegistered = new Set(p.hrdfRegisteredCompanyIds ?? []);
  const catalogue = p.payItemSubjects ?? {};
  const yearPrefix = `${p.year}-`;

  const acc = new Map<string, HistoryGridRow>();
  /** Which month supplied the subject stamp currently on a row — a LATER run's answer replaces an
   *  earlier one, so the column shows the most recent thing that was actually true of real pay. */
  const subjectMonth = new Map<string, number>();
  let payslipCount = 0;
  let detailNotRecorded = false;
  let basesNotRecorded = false;
  // 3c88d593 — per (companyId, runType), whether EVERY contributing payslip's lump-sum row was fully
  // explained by its items. Keyed by run type because the rows are: an additional run's item detail
  // describes only the bonus it pays (6b134681 — and a bonus run calculated before that stamps nothing at
  // all), so its answer about Allowances must not be able to suppress the regular run's line, or be
  // suppressed by it. Keyed by COMPANY for the same reason, now that the rows are: one employer's fully
  // itemised August must not delete the OTHER employer's Allowances row, whose money nothing else on the
  // screen would then account for.
  const lumpAccounted = new Map<string, { allowance: boolean; otherDeductions: boolean }>();
  const lumpKey = (companyId: string, runType: string) => `${companyId} ${runType}`;

  for (const row of p.rows) {
    if (!row.payPeriod.startsWith(yearPrefix)) continue;
    const month = Number(row.payPeriod.slice(5, 7));
    if (!Number.isInteger(month) || !shown.has(month)) continue;
    payslipCount += 1;

    // 3c88d593 — what this slip actually covered, from its own record (0446 columns, then the r194 jsonb
    // stamp, then the whole period). NULL on every payslip whose month nobody split, which is every
    // payslip this system issued before an entity transfer existed — those rows grow no `segments` and
    // render byte-identical to before.
    const segment = payslipSegmentOf(row, row.payPeriod);

    const slip = cellsFor(row, p.payItemNames);
    if (slip.detailNotRecorded) detailNotRecorded = true;
    if (slip.basesNotRecorded) basesNotRecorded = true;
    const lk = lumpKey(row.companyId, row.runType);
    const lump = lumpAccounted.get(lk) ?? { allowance: true, otherDeductions: true };
    lump.allowance &&= slip.lumpAccounted.allowance;
    lump.otherDeductions &&= slip.lumpAccounted.otherDeductions;
    lumpAccounted.set(lk, lump);
    for (const c of slip.cells) {
      // `kind` and `group` are in the key, not just the code. Two DIFFERENT things can carry one code and
      // must never be summed into a single line: the synthetic BASIC row and a pay item an operator coded
      // BASIC; a cash pay item and a record-only line of the same code (f1564110 Phase 3 merges consumed
      // one-off transactions into recordLines by name); an item that was an earning in January and a
      // deduction in March. Each of those merges would double a figure on a reconciliation screen and look
      // entirely plausible while doing it.
      //
      // 3c88d593 — and the PAYING COMPANY, for the same reason one level out: two employers' figures for
      // one (item, run type, month) are two different things and summing them hid an entity transfer
      // entirely. See this file's header for why no figure moves.
      const key = `${c.kind}:${c.group}:${c.code}:${row.runType}:${row.companyId}`;
      let target = acc.get(key);
      if (!target) {
        target = {
          key,
          kind: c.kind,
          code: c.code,
          labelKey: c.labelKey,
          name: c.name,
          runType: row.runType,
          companyId: row.companyId,
          company: row.company,
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
      // 3c88d593 — the covered window, recorded ONCE per distinct range: the outgoing employer's row runs
      // a full January through to a 1–10 August and there is no honest way to reduce that to one line.
      // Only a SEGMENTED slip contributes; an unsegmented one leaves `segments` absent entirely.
      if (segment && !target.segments?.some((s) => s.from === segment.from && s.to === segment.to)) {
        (target.segments ??= []).push(segment);
      }
      // 0253dc7c — an UNRECORDED wage base does not add zero, it adds nothing, and the cell says so.
      // The month keeps whatever a sibling run of the same type already put there (there is normally
      // none), so a recorded figure is never overwritten by an unknown.
      if (c.unrecorded) {
        target.unrecordedMonths ??= new Array(12).fill(false);
        target.unrecordedMonths[month - 1] = true;
      } else {
        target.months[month - 1] = round2(target.months[month - 1] + c.amount);
      }
      // 0253dc7c — the subject stamp, latest month wins (see `subjectMonth`).
      if (c.stampedSubject && month >= (subjectMonth.get(key) ?? 0)) {
        subjectMonth.set(key, month);
        target.subject = { ...c.stampedSubject, source: 'payslip' };
      }
    }
  }

  const rows = [...acc.values()];
  let subjectFromCatalogue = false;
  const lumpFor = (r: HistoryGridRow) =>
    lumpAccounted.get(lumpKey(r.companyId, r.runType)) ?? { allowance: false, otherDeductions: false };
  for (const r of rows) {
    r.total = round2(r.months.reduce((s, m) => s + m, 0));
    // Ascending, so the two halves of a transferred month read in the order they were worked.
    if (r.segments) r.segments.sort((a, b) => a.from.localeCompare(b.from));
    // efece4ce, and 3c88d593 — asked of THIS ROW'S OWN EMPLOYER. The row is one company's HRDF line now,
    // so a registered incoming company must not silently answer for the outgoing one.
    if (r.kind === 'synthetic' && r.labelKey === 'hrdf' && !hrdfRegistered.has(r.companyId)) {
      r.notRegistered = true;
    }
    // 0253dc7c — the catalogue fallback, for any row whose code IS a pay item and that carries no
    // stamp of its own. This deliberately fills the synthetic BASIC row (the BASIC pay item exists
    // and is ticked into everything, and the ticket asks to see it); every synthetic row whose
    // display code is NOT a component code — ALLOW, OT, EPF_EE, GROSS, the wage bases — matches
    // nothing and stays blank, which is the "should remain blank" the ticket asks for.
    if (!r.subject) {
      const cat = catalogue[r.code];
      if (cat) {
        r.subject = { ...cat, source: 'catalogue' };
        subjectFromCatalogue = true;
      }
    }
    // 0253dc7c — suppress a lump-sum row only when EVERY contributing month of ITS OWN run type was
    // fully accounted for by item rows. Marked here, dropped in `filterGridRows`, so the pivot's own
    // reconciliation invariants (Σ earnings = Σ gross, Σ deductions = Σ total deductions) are
    // computed over the complete row set exactly as before.
    if (r.kind === 'synthetic' && r.labelKey === 'allowance' && lumpFor(r).allowance) r.itemised = true;
    if (r.kind === 'synthetic' && r.labelKey === 'otherDeductions' && lumpFor(r).otherDeductions) {
      r.itemised = true;
    }
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
    // 3c88d593 — COMPANY BEFORE RUN TYPE, so the two halves of a transferred month sit next to each other
    // under the item they belong to instead of being separated by a bonus run.
    const co = a.company.localeCompare(b.company);
    if (co !== 0) return co;
    return a.runType.localeCompare(b.runType);
  });

  return { rows, months, payslipCount, detailNotRecorded, basesNotRecorded, subjectFromCatalogue };
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
    // 0253dc7c — the lump-sum row the item rows already account for, in every month. NOT a switch and
    // NOT `hideSystem`: that one is all-or-nothing by design (it also removes EPF, SOCSO, EIS, PCB,
    // Gross and Net), which is exactly why nobody used it for this. Applied HERE rather than in the
    // pivot so the screen and the export cannot diverge — both call this function.
    if (r.itemised) return false;
    if (opts.hideSystem && r.kind === 'synthetic') return false;
    // `notRegistered` survives hide-zero on purpose. Its zeroes are a POLICY STATEMENT — the company is
    // not registered for the levy — and hide-zero exists to drop rows that carry no information. Letting
    // the default switch delete the one row that explains itself would recreate feedback efece4ce, where
    // an unregistered company was indistinguishable from a levy that failed to compute.
    //
    // 0253dc7c — an UNRECORDED wage base survives it for the same reason: "we did not write this
    // down" is information, and its cell is an em dash, not a zero. Dropping the row would leave the
    // operator with no wage-base block at all on an older year and nothing saying why.
    if (
      opts.hideZero &&
      !r.notRegistered &&
      !r.unrecordedMonths?.some(Boolean) &&
      r.months.every((m) => m === 0)
    ) {
      return false;
    }
    return true;
  });
}
