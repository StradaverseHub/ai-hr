/**
 * 4e403268 — the pure half of DAY-BY-DAY entry: the line model, the day-of-week derivation, the running
 * totals and the per-line validity rule.
 *
 * No React, no db, no i18n — the same split `existing-context.ts` already uses on this screen, and for the
 * same reason: the arithmetic and the refusals are what is worth unit-testing, and none of them needs a
 * session or a rendered tree.
 *
 * WHAT IS *NOT* HERE, AND MUST NEVER BE: any evaluation of a pay item's rule. Each day's amount is
 * resolved on the SERVER by `deriveIndividualTxnAmount` — the same evaluator the payslip uses and the same
 * one the save calls — and arrives here as a formatted string. Re-implementing "hours × rate" in the
 * browser would be a second evaluator, and the moment a rule became a formula reading another pay item the
 * two would part company, with the difference showing up as money on a payslip. 2da9937a made that rule
 * for the single-entry form; day-by-day does not get to break it because there are five figures instead of
 * one.
 *
 * PER-DAY ROUNDING IS A REAL DIFFERENCE AND IT IS DELIBERATE. Each day is priced and rounded to the cent
 * on its own, so a split can total a cent away from the same quantity keyed as one figure. Irwin Law's
 * fifteen August hours are RM584.13 as one entry and RM584.14 split 2/3/2.5/4/3.5 across five days. Per-day
 * is the right answer because the amount printed against a date has to be the amount that date is worth —
 * a subtotal that does not equal its own lines is worse than a cent. It is stated on the approved plan
 * rather than hidden, and `test/existing-txn-context.test.ts` pins it so it cannot drift silently.
 */

/** One dated line in the grid. `amount` is only the operator's to fill on a pay item that does NOT
 *  calculate; on one that does it is ignored and the server's figure is used (see `dayLineTotals`). */
export type DayLine = {
  /** Client-only identity for React keys and for addressing a derived figure. Never persisted. */
  key: string;
  /** 'YYYY-MM-DD'. */
  txnDate: string;
  /** Hours / days / units, as typed. */
  quantity: string;
  /** Typed money, for a pay item with no rule of its own. */
  amount: string;
  notes: string;
};

let seq = 0;
/** A fresh blank line. The key is a monotonic counter rather than a random id so a test can predict it. */
export const blankDayLine = (): DayLine => ({ key: `d${++seq}`, txnDate: '', quantity: '', amount: '', notes: '' });

/**
 * ISO weekday index of a 'YYYY-MM-DD' date: 0 = Sunday … 6 = Saturday.
 *
 * PARSED AT UTC MIDNIGHT, and that is the whole trick. `new Date('2026-08-01')` is already UTC-midnight in
 * every engine, but `new Date('2026-08-01T00:00:00')` is LOCAL midnight, and the difference is a whole day
 * for a browser west of Greenwich. The date here is a CALENDAR DAY, not an instant — it names the day the
 * work happened, in the tenant's own calendar — so pinning it to UTC is what makes the weekday label
 * independent of where the operator's laptop thinks it is. The same idiom core/attendance.ts and
 * lib/roster-month.ts already use.
 *
 * Returns null for anything that is not a well-formed date, rather than the epoch's Thursday.
 */
export function dayOfWeekIndex(iso: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const t = Date.parse(`${iso}T00:00:00Z`);
  return Number.isNaN(t) ? null : new Date(t).getUTCDay();
}

/** DERIVED FOR DISPLAY, NEVER STORED. The ledger has a date; the day of the week is a fact about that date
 *  and storing it would create a second copy that an edit could contradict. */
export const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type DayKey = (typeof DAY_KEYS)[number];
export const dayKeyOf = (iso: string): DayKey | null => {
  const i = dayOfWeekIndex(iso);
  return i == null ? null : DAY_KEYS[i];
};

const cents = (v: string | number | null | undefined) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
const fixed2 = (c: number) => (c / 100).toFixed(2);

export type DayLineTotals = {
  count: number;
  /** Summed quantity, or null when no line carries one (an item that needs no quantity). */
  quantity: string | null;
  /**
   * Summed money, or NULL while any line's figure is still unknown — a server round trip in flight, or a
   * rule that could not be evaluated. A partial sum presented as "the total" is the one number on this
   * screen that would be believed and wrong, so it is withheld instead.
   */
  amount: string | null;
};

/**
 * The running totals under the grid.
 *
 * `amountFor` is how the caller supplies each line's money: the server's derived figure on a calculating
 * pay item, the typed `amount` on one that has no rule. Returning null for a line means "not known yet",
 * and one unknown line makes the whole total unknown.
 */
export function dayLineTotals(
  lines: readonly DayLine[],
  amountFor: (line: DayLine) => string | null,
): DayLineTotals {
  let qtyC = 0;
  let qtyN = 0;
  let amtC = 0;
  let unknown = false;
  for (const l of lines) {
    if (l.quantity.trim() !== '' && Number.isFinite(Number(l.quantity))) {
      qtyC += cents(l.quantity);
      qtyN += 1;
    }
    const a = amountFor(l);
    if (a == null || !Number.isFinite(Number(a))) unknown = true;
    else amtC += cents(a);
  }
  return {
    count: lines.length,
    quantity: qtyN > 0 ? fixed2(qtyC) : null,
    amount: unknown ? null : fixed2(amtC),
  };
}

/** What one line is missing, as an i18n key the screen resolves — or null when the line is ready to save.
 *  Mirrors the single-entry form's `formInvalid`, narrowed to the fields a line actually has. The SERVER
 *  re-validates every one of these (assertDateInPeriod, the derived amount, AmountNotPositiveError); this
 *  only avoids a round trip and lets the grid mark the offending row. */
export function dayLineIssue(
  line: DayLine,
  p: {
    /** The pay month's first and last day, inclusive. */
    bounds: { min: string; max: string } | null;
    /** The quantity this pay item's rule needs keyed, or null when it needs none. */
    requiredUnit: 'hours' | 'days' | null;
    /** The pay item works its own amount out, so `amount` is not the operator's to fill. */
    derives: boolean;
    /** The server's figure for this line, when the item calculates. Null while it is unknown. */
    derivedAmount: string | null;
  },
): string | null {
  if (!line.txnDate) return 'rowIncomplete';
  if (p.bounds && (line.txnDate < p.bounds.min || line.txnDate > p.bounds.max)) return 'dateOutOfPeriod';
  if (line.quantity.trim() !== '' && !Number.isFinite(Number(line.quantity))) return 'rowIncomplete';
  if (p.derives) {
    if (p.requiredUnit && !(Number(line.quantity) > 0)) {
      return p.requiredUnit === 'hours' ? 'quantityRequiredHours' : 'quantityRequiredDays';
    }
    if (p.derivedAmount == null) return 'derivedAmountPending';
    if (!(Number(p.derivedAmount) > 0)) return 'amountNotPositive';
    return null;
  }
  if (!(Number(line.amount) > 0)) return 'amountNotPositive';
  return null;
}

/**
 * Two lines on the SAME DATE with the same quantity and the same remark are a double-post, and the service
 * already refuses them (`DuplicateTxnRowError`, on a byte-for-byte row signature within one submission).
 * Catching it here means the operator is told which two rows collide instead of losing a whole grid to one
 * refusal at the end.
 *
 * Note what is NOT flagged: two lines on the same date with DIFFERENT quantities or remarks. Two overtime
 * stints on one day, or an hour on Project A and two on Project B, are legitimate and stay legal — which
 * is the same position `createIndividualTxnsBulk` takes.
 */
export function duplicateDayLineKeys(lines: readonly DayLine[]): string[] {
  const seen = new Map<string, string>();
  const dupes: string[] = [];
  for (const l of lines) {
    if (!l.txnDate) continue;
    const sig = `${l.txnDate}|${l.quantity.trim()}|${l.amount.trim()}|${l.notes.trim().toLowerCase()}`;
    if (seen.has(sig)) dupes.push(l.key);
    else seen.set(sig, l.key);
  }
  return dupes;
}

/**
 * The DISTINCT quantities in the grid, so the preview asks the server for each figure ONCE.
 *
 * The derived amount is a function of (pay item, employment, company, month, quantity, unit) and nothing
 * else — five days of 2.00 hours are five copies of one answer. Deduplicating here is what turns "one
 * request per row per keystroke" into one request carrying at most a handful of numbers, without the
 * client ever doing arithmetic of its own.
 */
export function distinctQuantities(lines: readonly DayLine[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const l of lines) {
    const q = l.quantity.trim();
    if (q === '' || !Number.isFinite(Number(q)) || !(Number(q) > 0)) continue;
    // Normalised through Number so '2' and '2.00' are one question, not two.
    const norm = String(Number(q));
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  return out.sort();
}

/** The lookup key a derived figure is stored under — the normalised quantity, matching `distinctQuantities`. */
export const quantityKey = (quantity: string): string => {
  const q = quantity.trim();
  return q === '' || !Number.isFinite(Number(q)) ? '' : String(Number(q));
};
