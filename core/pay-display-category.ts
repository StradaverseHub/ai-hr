/**
 * Feedback 3c473773 — the PAYROLL CATEGORY of a pay item: which box on the payslip its money appears in.
 *
 * WHY THIS EXISTS. Until now the payslip box was INFERRED, never declared. core/payroll.ts `earningsOf`
 * routes a component's cash into one of five kernel buckets — wage / ot / bonus / reimburse / deduct — and
 * that routing is a STATUTORY decision: the wage bucket feeds the EPF/SOCSO/EIS/PCB normal-wage base, the
 * ot bucket feeds the overtime leg (EPF-exempt, SOCSO/EIS/PCB-bearing), the bonus bucket feeds additional
 * remuneration (EPF + PCB difference method, outside SOCSO/EIS). The payslip then displayed whichever
 * bucket the money landed in.
 *
 * That conflates two different questions. The reporter's Overtime 1.5 pay code is declared
 * `pcb_remuneration_type = 'additional'`, which is CORRECT — overtime paid in arrears is additional
 * remuneration for LHDN — and the kernel therefore routes it to the bonus bucket and the payslip prints it
 * under Bonus. Nothing is miscalculated; the payslip is describing a tax decision as if it were a category.
 *
 * SO THE CATEGORY IS PRESENTATION ONLY, AND MUST STAY THAT WAY. Re-routing the KERNEL bucket would move
 * the amount between statutory bases and change EPF, SOCSO, EIS and PCB — i.e. corrupt payroll that is
 * currently correct, and change what is filed with KWSP/PERKESO/LHDN. It does not do that. It re-labels
 * where a figure is DISPLAYED and nothing else; the stored payslip columns, every statutory base and every
 * statutory form keep the kernel's bucketing untouched.
 *
 * BYTE-IDENTICAL BY CONSTRUCTION. `defaultCategoryOfBucket` is the mapping the product already had
 * implicitly, so migration 0393 backfills every existing row to exactly the box it prints in today. A row
 * whose category equals its bucket default causes NO re-bucketing at all — the kernel does not even stamp
 * the overlay (see core/payroll.ts `displayEarnings`), so those payslips are byte-for-byte what they were.
 */

/** The boxes an operator can put a pay item in — the reporter's own list (their table: BASIC / OT15 /
 *  BONUS / CLAIM / ALLOW / DED). `reimbursement` is deliberately NOT among them: it has no distinct box on
 *  any payslip in this product, so offering it would promise a line that cannot appear. */
//  711adcd2 adds `bik` — Benefit in Kind. The reporter's own pairing is Category = Non-Payable with
//  Payroll Category = Benefit in Kind (BIK), and a non-payable item is RECORDED, never paid: it never
//  reaches a cash bucket at all (core/payroll.ts pushes it to `recordLines`), so the label describes
//  exactly the line it is put on. What it may NOT do is re-box money that WAS paid — see
//  resolveDisplayCategory's third refusal below.
export const PAY_DISPLAY_CATEGORIES = ['basic', 'overtime', 'bonus', 'allowance', 'claim', 'deduction', 'bik'] as const;
export type PayDisplayCategory = (typeof PAY_DISPLAY_CATEGORIES)[number];

/** The kernel's cash buckets (core/payroll.ts earningsOf). Repeated here rather than imported because that
 *  type is function-local to the kernel; test/pay-display-category.test.ts pins the two in step. */
export type PayKernelBucket = 'wage' | 'ot' | 'bonus' | 'reimburse' | 'deduct';

/**
 * The box a kernel bucket prints in TODAY, before anyone declares a category. This is the whole
 * byte-identical guarantee in one function, so it is stated once and read by the kernel, the backfill's
 * documentation and the tests alike.
 *
 * `reimburse` maps to `allowance` because that is where it already shows: the kernel folds the reimburse
 * bucket into the payslip's allowance column (`allowance = allowanceApplied + reimburse + otConvert`).
 * Mapping it to a `claim` box instead would MOVE money on screen on release day, which is exactly what the
 * approved plan forbade.
 */
export function defaultCategoryOfBucket(bucket: PayKernelBucket): PayDisplayCategory {
  switch (bucket) {
    case 'ot':
      return 'overtime';
    case 'bonus':
      return 'bonus';
    case 'deduct':
      return 'deduction';
    // wage and reimburse both print on the Allowances line today.
    default:
      return 'allowance';
  }
}

/**
 * Resolve the box for one contribution.
 *
 * Three refusals, all deliberate:
 *  - a DEDUCTION contribution is always the deduction box. A display setting must never be able to turn a
 *    deduction into an earning (or the reverse): gross and net would stop reconciling on screen.
 *  - `deduction` declared on an EARNING contribution falls back to the bucket default, for the same reason.
 *  - 711adcd2: `bik` declared on a CASH contribution falls back to the bucket default. A Benefit in Kind is
 *    by definition not cash; a non-payable item never reaches this function (it is recorded, not bucketed),
 *    so anything that DOES reach it here was actually paid. Printing paid money under a non-cash heading
 *    would both mislabel it and break the invariant every payslip renderer relies on — that the five cash
 *    boxes sum to gross. The tick is still stored and still shown on the Pay Items screen; it simply
 *    cannot move a paid ringgit out of the box it was paid in.
 *
 * An unclassified row (null — a legacy row the backfill could not classify, or one created before 0393)
 * keeps the inference. Deleting the inference is what would silently lose a legacy row's box.
 */
export function resolveDisplayCategory(
  declared: string | null | undefined,
  bucket: PayKernelBucket,
): PayDisplayCategory {
  const fallback = defaultCategoryOfBucket(bucket);
  if (bucket === 'deduct') return 'deduction';
  if (declared == null) return fallback;
  if (declared === 'deduction') return fallback;
  if (declared === 'bik') return fallback; // 711adcd2 — see the third refusal above.
  return (PAY_DISPLAY_CATEGORIES as readonly string[]).includes(declared)
    ? (declared as PayDisplayCategory)
    : fallback;
}

/** Coerce form/URL input to a stored category, or null. An unknown value never persists. */
export function cleanDisplayCategory(v: unknown): PayDisplayCategory | null {
  return (PAY_DISPLAY_CATEGORIES as readonly string[]).includes(v as string) ? (v as PayDisplayCategory) : null;
}

/**
 * The earnings figures a payslip SCREEN should print, as opposed to the columns the kernel stored for
 * statutory purposes.
 *
 * `displayEarnings` is stamped on the payslip's own statutory blob at generate time, and ONLY when at
 * least one pay item was declared into a different box than the kernel routed it to. Absent ⇒ every
 * existing payslip, and every run with nothing re-categorised ⇒ the stored columns, unchanged. It is read
 * from the payslip's OWN blob and never re-derived from today's pay-item setup: a payslip is a historical
 * document, and re-deriving would let a category changed in March silently rewrite January.
 */
export type PayslipDisplayEarnings = {
  basic: number;
  allowance: number;
  overtime: number;
  bonus: number;
  claim: number;
};

const n = (v: unknown) => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};

/**
 * Read the display earnings off a payslip row. Falls back to the stored columns — which is the correct
 * answer, not a degraded one, for every payslip with nothing re-categorised.
 *
 * NOTE on the allowance line: `displayEarnings.allowance` INCLUDES any converted OT excess
 * (`statutory.otConvert`), exactly as the stored allowance column does, so a caller that subtracts
 * otConvert to show a dedicated line keeps the same expression it already had.
 */
export function payslipDisplayEarnings(row: {
  basic?: unknown;
  allowance?: unknown;
  overtime?: unknown;
  bonus?: unknown;
  statutory?: unknown;
}): PayslipDisplayEarnings {
  const st = (row.statutory ?? {}) as { displayEarnings?: Partial<PayslipDisplayEarnings> };
  const d = st.displayEarnings;
  if (!d) {
    return {
      basic: n(row.basic),
      allowance: n(row.allowance),
      overtime: n(row.overtime),
      bonus: n(row.bonus),
      claim: 0,
    };
  }
  return {
    basic: n(d.basic),
    allowance: n(d.allowance),
    overtime: n(d.overtime),
    bonus: n(d.bonus),
    claim: n(d.claim),
  };
}
