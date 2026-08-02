/**
 * Money formatting and MIXED-CURRENCY REFUSAL (ADR-0080 slice 6, D-9).
 *
 * WHY THIS EXISTS. The product began single-country, and twelve separate screens each defined their own
 * `rm = (n) => \`RM ${n.toLocaleString('en-MY')}\``. Two different faults hide in that:
 *
 *   1. A MISLABELLED figure — "RM 4,200" against a company that does not pay in ringgit. Cosmetic, but it
 *      is a statement about someone's pay, so it is not harmless.
 *   2. A WRONG figure — a grand total that ADDS ringgit to some other currency and prints one number.
 *      That is arithmetic nobody authorised, and no amount of relabelling fixes it.
 *
 * The second is the one that matters, so the primitive here is not a formatter but a REFUSAL: a total
 * over mixed currencies has no value, and this module makes that unrepresentable rather than merely
 * discouraged. r115 fixed the overtime report this way (it labels its currency and resolves per company);
 * this generalises that so the next report cannot reintroduce it.
 *
 * DELIBERATELY NOT SWEPT: the Malaysian statutory configuration screens (EPF / SOCSO / EIS / PCB /
 * SKBBK). Those render the figures OF a Malaysian statutory ruleset — the ringgit is part of what the
 * table IS, not an assumption about the reader's company. Relabelling them by company currency would
 * make them wrong. See core/company-tier.ts for the statutory / non-statutory distinction.
 */

/** ISO-4217 code, as stored on `company.currency`. Absent ⇒ we do not know, and must not guess. */
export type CurrencyCode = string;

/**
 * Format one amount in a named currency. The code is rendered as a PREFIX rather than through
 * `Intl.NumberFormat`'s `style: 'currency'` on purpose: the latter localises the symbol to the reader's
 * locale ("RM" becomes "MYR" or "$" depending on the tag), and a payroll figure must read identically to
 * everyone looking at the same screen.
 *
 * A null/absent currency prints the bare number with no prefix — an unlabelled figure is honest about
 * being unlabelled, where a defaulted "RM" would be a claim.
 */
export function formatMoney(n: unknown, currency: CurrencyCode | null | undefined, locale = 'en-MY'): string {
  const v = typeof n === 'string' ? Number(n) : typeof n === 'number' ? n : Number.NaN;
  if (!Number.isFinite(v)) return '—';
  const amount = v.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency ? `${currency} ${amount}` : amount;
}

/**
 * The ONE currency shared by every row, or null when the rows disagree (or there are none).
 *
 * Null is the signal to show per-currency subtotals instead of a single total. Callers must branch on
 * it — see `totalsByCurrency`.
 */
export function singleCurrencyOf(rows: readonly { currency?: CurrencyCode | null }[]): CurrencyCode | null {
  const seen = new Set<string>();
  for (const r of rows) {
    // An unknown currency is its own bucket, not a match for anything. Treating absent as "same as the
    // others" is precisely how a foreign row gets silently folded into a ringgit total.
    seen.add(r.currency ?? '');
    if (seen.size > 1) return null;
  }
  const [only] = [...seen];
  return only ? only : null;
}

/** True when the rows span more than one currency — i.e. a single grand total would be meaningless. */
export function isMixedCurrency(rows: readonly { currency?: CurrencyCode | null }[]): boolean {
  const seen = new Set<string>();
  for (const r of rows) {
    seen.add(r.currency ?? '');
    if (seen.size > 1) return true;
  }
  return false;
}

/**
 * Subtotals, one per currency, in stable currency order.
 *
 * SUMMED IN CENTS. Adding the decimal strings as floats drifts on exactly the four-figure amounts these
 * screens exist to surface — the same reason the outstanding table already totalled in cents before this
 * module existed.
 *
 * There is deliberately NO `grandTotal` here. A caller that wants one number can ask `singleCurrencyOf`
 * first; if it returns null there is no number to give, and this module will not invent one.
 */
export function totalsByCurrency(
  rows: readonly { currency?: CurrencyCode | null; amount: number | string }[],
): { currency: CurrencyCode | null; total: number }[] {
  const cents = new Map<string, number>();
  for (const r of rows) {
    const key = r.currency ?? '';
    const v = typeof r.amount === 'string' ? Number(r.amount) : r.amount;
    if (!Number.isFinite(v)) continue;
    cents.set(key, (cents.get(key) ?? 0) + Math.round(v * 100));
  }
  return [...cents.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([currency, c]) => ({ currency: currency ? currency : null, total: c / 100 }));
}
