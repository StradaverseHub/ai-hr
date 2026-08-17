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
