/**
 * Feedback 6b134681 + 417d4937 — ONE ROOT CAUSE, THREE SURFACES.
 *
 * Both board items say the same thing in two shapes: a payroll result screen printed a CATEGORY
 * ("Bonus") or a stale free-text REMARK ("A0020 — DIRECTOR FEE") where the PAY ITEM's own code and
 * description belonged. The information was never lost — the kernel stamps every processed line into
 * `statutory.componentLines` with its code, its name and the figures it contributed to
 * (core/payroll.ts `earningsOf`). What was missing is that each renderer decided for itself which
 * buckets to itemise and how to label a line, so the ESS payslip, the PDF and Transaction View →
 * History could and did disagree about the same ringgit.
 *
 * This module is the single answer to both questions, so the three surfaces cannot drift:
 *
 *   1. WHICH LINES explain a summarised figure  → `payItemLinesForBuckets`
 *   2. HOW A LINE IS LABELLED                   → `payItemLabel` (code + description, never a category)
 *   3. MAY THEY REPLACE THE LUMPED ROW          → `payItemLinesReconcile`
 *
 * THREE RULES THIS FILE EXISTS TO HOLD IN ONE PLACE:
 *
 *  a. READ THE PAYSLIP'S OWN STAMP, never today's pay-item catalogue. A description edited in March must
 *     not rewrite what January's payslip said, and a payslip issued before the stamp existed has no
 *     detail to recover — it yields an empty list, which every caller renders as the grouped row it
 *     always showed (plus the `detailNotRecorded` caption where one exists).
 *
 *     417d4937 CARVES ONE NARROW, DELIBERATE EXCEPTION OUT OF RULE (a), AND ONLY ONE: `recordLines`.
 *     See `recordLineIdentity` below for the whole argument. `componentLines` keep rule (a) untouched —
 *     they were never wrong, which is why Transaction Detail's grid rows were correct all along.
 *
 *  b. NO ARITHMETIC BEYOND COPYING. A bucket's stored contribution is summed and rounded, nothing is
 *     re-derived. That is what makes the itemised rows incapable of disagreeing with the total printed
 *     beside them.
 *
 *  c. RECONCILE BEFORE REPLACING. A payslip whose display categories moved money between boxes
 *     (3c473773 `displayEarnings`) has a stored FIGURE that no longer equals the sum of its lines.
 *     Printing the lines there would put rows on a money document that do not add up to the total above
 *     them, so the named rows replace a grouped row only when they reconcile to it.
 *
 * Pure and dependency-free: imported by `lib/payslip-pdf.ts` (the printed document), the ESS payslip
 * server component and the client History table. No DB, no i18n, no React — deliberately, because a
 * client bundle pulls this in.
 */

/** Which summarised figure a pay item's money landed in. Mirrors the kernel's stamp in core/payroll.ts
 *  `earningsOf` — these names are a STORED contract, not a display choice. */
export type EarningBucket = 'wage' | 'ot' | 'bonus' | 'reimburse' | 'deduct';

/** One `statutory.componentLines` entry, read STRUCTURALLY. Read by shape rather than by importing the
 *  kernel's type so that `lib/` and a client component can use it without dragging core/payroll in. */
export type StoredComponentLine = {
  code?: string | null;
  name?: string | null;
  amount?: unknown;
  buckets?: { bucket?: string | null; amount?: unknown }[] | null;
};

/** A pay item as a renderer needs it: its own code, its own description, and what it contributed. */
export type NamedPayItemLine = { code: string | null; name: string; amount: number };

const n = (v: unknown) => Number(v ?? 0);
const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * `A0040 · MEAL ALLOWANCE` — the pay item's identity, in the one format every screen uses.
 *
 * THE WHOLE POINT OF BOTH BOARD ITEMS. The category (Bonus / Allowance / Overtime) says which box the
 * money landed in; it never gets to stand in for the item's own name. A line with no code prints its
 * description alone rather than an empty prefix, and a line with no description prints its code — an
 * unlabelled row on a payslip is worse than a terse one.
 */
export function payItemLabel(l: { code?: string | null; name?: string | null }): string {
  const code = (l.code ?? '').trim();
  const name = (l.name ?? '').trim();
  if (!code) return name;
  if (!name) return code;
  return `${code} · ${name}`;
}

/**
 * Today's pay-item catalogue, as a renderer needs it: CODE → the item's current description.
 *
 * Keyed by code because that is the only thing a line written months ago and a catalogue row have in
 * common — the id is meaningless to a stored line, and the description is the thing being repaired.
 * Plain data on purpose: it crosses the RSC boundary to the client History table, and a function prop
 * there returns a 500 on every request while tsc, the suite and `next build` all stay green.
 */
export type PayItemNames = Record<string, string>;

/**
 * 417d4937 — HOW A **RECORD LINE** IS LABELLED, AND THE ONE PLACE RULE (a) IS REVERSED.
 *
 * THE DEFECT. r196 taught the kernel to name a consumed one-off's record line from the PAY ITEM
 * (`row.name`) instead of from the transaction's free-text remark (`t.notes`). That fix is FORWARD-ONLY:
 * it takes effect when a run is CALCULATED, and no screen re-derives it afterwards. So a payslip written
 * before that deploy carries "A0020 - DIRECTOR FEE" against pay item A0040 forever, on every surface that
 * prints `statutory.recordLines` — which is exactly what the reporter re-opened Transaction View and saw.
 * Nothing on the plan said the fix could not reach an already-calculated run.
 *
 * WHY REVERSING RULE (a) IS RIGHT **HERE** AND WRONG EVERYWHERE ELSE. Rule (a) protects a figure's
 * PROVENANCE: what January's payslip said about January's money. A TXN-DERIVED record line's `name` is not
 * provenance — before r196 it was a free-text remark that had no defined relationship to the item at all,
 * which is the whole defect. Showing the catalogue's description against the stored CODE is strictly more
 * truthful than showing words that were never that item's. The stated trade-off, which the reporter
 * approved in as many words: an item whose description has since been EDITED will show its current
 * description on an older payroll. The code and the amount are untouched either way.
 *
 * ...AND WHY THAT ARGUMENT DOES NOT REACH THE **BIK** HALF OF THE SAME ARRAY, WHICH IS WHY THERE IS A
 * BRANCH. `statutory.recordLines` is an explicitly MIXED population (core/payroll.ts `PayslipRecordLine`
 * says so): the txn-derived lines `pushTxnLine` writes, and the record-only benefits in kind `earningsOf`
 * writes as `{ code: c.code, name: c.name, …, nonPayable: true }`. A BIK line's `name` IS the pay item's
 * own description as it stood when the run folded it — genuine provenance, of exactly the kind rule (a)
 * exists to protect, and never a remark anyone typed. Repairing it would do two wrong things at once:
 * print today's naming about a month already paid, and caption it "Entered as …", asserting that an
 * operator typed words the SYSTEM generated. So a line stamped `nonPayable: true` is returned untouched.
 *
 * THE DISCRIMINATOR IS THE STORED FLAG, NEVER A RE-DERIVATION. `nonPayable` is stamped at write time
 * (f35f758a, r185) — `false` by `pushTxnLine`, `true` by both BIK push sites — and matching a code back to
 * today's `pay_component.is_non_payable` would answer with today's configuration about last month's pay,
 * which is the same mistake in a different place.
 *
 * AN UNFLAGGED LINE (a payslip calculated before r185) IS REPAIRED, and that is the treatment the kernel
 * already prescribes, not an exception to it: an unflagged list must be read as ONE list, exactly as it is
 * read today, and the only other reader of this flag — `nonPayableLinesOf` in lib/payslip-pdf.ts — takes
 * `=== true` for the same reason, leaving everything else in the ordinary population. Withholding the
 * repair from unflagged lines would instead strand the reporter's own case, whose payslips predate r185.
 * It costs nothing today: the production catalogue has ZERO non-payable pay items (verified 2026-08-10),
 * so no unflagged BIK line exists to mislabel.
 *
 * NOTHING IS REWRITTEN OR HIDDEN. When the stored words differ from the catalogue they are returned as
 * `remark`, for the caller to print underneath. Both are on screen, which is what an audit needs.
 *
 * THE SYNTHETIC CODES NEED NO BRANCH. `TXN_OVERTIME` / `TXN_UNPAID` / `TXN_LEAVE` / `TXN_EARNING` /
 * `TXN_DEDUCTION` (core/payroll.ts `pushTxnLine`) can never match a `pay_component.code`, so their
 * remark-derived names survive by construction rather than by a rule someone has to remember. Same for a
 * code that has been deleted from the catalogue, and for a caller that has no catalogue to hand.
 *
 * `label` IS CODE + DESCRIPTION; `name` IS THE DESCRIPTION ALONE. Both are returned because the surfaces
 * legitimately differ and neither should re-derive the other: the admin screens print the code (an
 * operator reconciles by code), while the EMPLOYEE's own payslip has always printed the description alone
 * and must keep doing so — "TXN_OVERTIME · Overtime (one-off)" is a worse answer for an employee than the
 * words they were shown before, and this item is not licence to change that.
 *
 * NOT APPLIED TO THE PRINTED PDF, deliberately (417d4937 scope). The document's only record-line surface
 * is `nonPayableLines` — the subset the KERNEL stamped `nonPayable: true`, which is empty on every
 * payslip in production and cannot contain the reporter's line (a paid one-off is never non-payable).
 * Wiring a catalogue read into both PDF routes to repair a list that is always empty would buy nothing
 * and would risk the two documents drifting apart if only one were wired.
 */
export function recordLineIdentity(
  l: { code?: string | null; name?: string | null; nonPayable?: boolean | null },
  names?: PayItemNames,
): { label: string; name: string; remark: string | null } {
  const code = (l.code ?? '').trim();
  const stored = (l.name ?? '').trim();
  // A stamped BIK keeps its stored name: that name is the pay item's own description as the run folded it,
  // i.e. provenance rule (a) protects, not a remark. See the docblock. `=== true` on purpose — an unflagged
  // line (pre-r185) is read as the ordinary population, exactly as `nonPayableLinesOf` reads it.
  const current = code && l.nonPayable !== true ? (names?.[code] ?? '').trim() : '';
  if (!current || current === stored) return { label: payItemLabel(l), name: stored, remark: null };
  return { label: payItemLabel({ code, name: current }), name: current, remark: stored || null };
}

/** The stored per-item stamp on a payslip's statutory blob, or an empty list where the run predates it. */
export function storedComponentLines(statutory: unknown): StoredComponentLine[] {
  const st = (statutory ?? {}) as { componentLines?: unknown };
  return Array.isArray(st.componentLines) ? (st.componentLines as StoredComponentLine[]) : [];
}

/**
 * The named pay items behind ONE summarised figure.
 *
 * `buckets` is a list because a single displayed figure can be fed by more than one stored bucket: the
 * payslip's allowance column is `wage + reimburse` (+ a converted OT excess, which the caller appends
 * because it is not a component line). A line that contributed NOTHING to the figure is not a row about
 * it and is dropped — otherwise a zero row would appear under every total in turn.
 */
export function payItemLinesForBuckets(
  lines: StoredComponentLine[],
  buckets: readonly EarningBucket[],
): NamedPayItemLine[] {
  const want = new Set<string>(buckets);
  const out: NamedPayItemLine[] = [];
  for (const l of lines) {
    const amount = round2(
      (l.buckets ?? []).filter((b) => b?.bucket != null && want.has(b.bucket)).reduce((s, b) => s + n(b.amount), 0),
    );
    if (amount === 0) continue;
    out.push({ code: l.code ?? null, name: l.name ?? '', amount });
  }
  return out;
}

/**
 * Do these named lines add up to the figure they claim to explain?
 *
 * Half a cent of tolerance, because every input is already rounded to the sen. An empty list NEVER
 * reconciles: a payslip with no stamp would otherwise "reconcile" to a zero figure and silently replace
 * the grouped row with nothing at all.
 */
export function payItemLinesReconcile(lines: NamedPayItemLine[], total: unknown): boolean {
  if (lines.length === 0) return false;
  return Math.abs(round2(lines.reduce((s, l) => s + l.amount, 0)) - round2(n(total))) < 0.005;
}
